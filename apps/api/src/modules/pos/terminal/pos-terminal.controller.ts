import { Controller, Get, Post, Param, Query, Body, Req, Headers, UnauthorizedException, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { Permissions, Public, NoTx, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import { verifyWebhookWithTimestamp } from '../../../common/crypto';
import { PosTerminalService } from './pos-terminal.service';
import { qint, qintOpt } from '../../../common/query';

const TerminalBody = z.object({ terminal_code: z.string().min(1), name: z.string().optional(), provider: z.string().optional() });
const ChargeBody = z.object({ terminal_code: z.string().optional(), sale_no: z.string().optional(), amount: z.number().positive(), tip: z.number().nonnegative().optional(), type: z.enum(['sale', 'preauth']).optional(), currency: z.string().optional(), token: z.string().optional(), record_tender: z.boolean().optional() });
const CaptureBody = z.object({ amount: z.number().positive().optional(), tip: z.number().nonnegative().optional() });
const RefundBody = z.object({ amount: z.number().positive() });
const SettleBody = z.object({ fee_pct: z.number().min(0).max(100).optional(), date: z.string().optional() });
const WebhookBody = z.object({ provider: z.string().min(1), provider_ref: z.string().min(1), status: z.string().min(1), event_id: z.string().max(120).optional() });
// C5 — the acquirer settlement report (rows keyed on the PSP's charge ref).
const SettlementReportBody = z.object({ rows: z.array(z.object({ provider_ref: z.string().min(1), amount: z.number(), fee: z.number().nonnegative().optional() })).min(1).max(5000) });

@Controller('api/payments/terminal')
@Permissions('pos', 'order_mgt', 'creditors', 'exec')
export class PosTerminalController {
  constructor(private readonly svc: PosTerminalService) {}

  @Post('register') register(@Body(new ZodValidationPipe(TerminalBody)) b: z.infer<typeof TerminalBody>, @CurrentUser() u: JwtUser) { return this.svc.registerTerminal(b, u); }
  @Get('terminals') terminals() { return this.svc.listTerminals(); }

  @Post('charge') charge(@Body(new ZodValidationPipe(ChargeBody)) b: z.infer<typeof ChargeBody>, @CurrentUser() u: JwtUser) { return this.svc.charge(b, u); }
  @Post('intents/:intentNo/capture') capture(@Param('intentNo') no: string, @Body(new ZodValidationPipe(CaptureBody)) b: z.infer<typeof CaptureBody>, @CurrentUser() u: JwtUser) { return this.svc.capture(no, b.amount, u, b.tip); }
  @Post('intents/:intentNo/void') voidIntent(@Param('intentNo') no: string) { return this.svc.voidIntent(no); }
  @Post('intents/:intentNo/refund') refund(@Param('intentNo') no: string, @Body(new ZodValidationPipe(RefundBody)) b: z.infer<typeof RefundBody>) { return this.svc.refundIntent(no, b.amount); }
  @Get('intents') intents(@Query('sale_no') saleNo?: string) { return this.svc.listIntents(saleNo); }

  @Post('settle') @Permissions('creditors', 'exec') settle(@Body(new ZodValidationPipe(SettleBody)) b: z.infer<typeof SettleBody>, @CurrentUser() u: JwtUser) { return this.svc.settle(b, u); }
  @Get('settlements') @Permissions('creditors', 'exec') settlements(@Query('limit') limit?: string) { return this.svc.listSettlements(qint('limit', limit, 50)); }
  @Post('settlements/:batchNo/reconcile') @Permissions('creditors', 'exec') reconcile(@Param('batchNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.reconcile(no, u); }
  // C5 — import + per-intent match of the acquirer's settlement report (zero discrepancies ⇒ Reconciled).
  @Post('settlements/:batchNo/import') @Permissions('creditors', 'exec') importReport(@Param('batchNo') no: string, @Body(new ZodValidationPipe(SettlementReportBody)) b: z.infer<typeof SettlementReportBody>, @CurrentUser() u: JwtUser) { return this.svc.importSettlementReport(no, b, u); }
  @Get('settlements/:batchNo/lines') @Permissions('creditors', 'exec') settlementLines(@Param('batchNo') no: string) { return this.svc.listSettlementLines(no); }
}

// PSP callback — no JWT. Authenticity is established by an HMAC-SHA256 signature over the raw body,
// keyed by a per-provider shared secret. The handler ALSO re-verifies status out-of-band via the
// provider API (see PosTerminalService.webhook), so this is defence-in-depth on a public, money-moving
// endpoint that can flip a payment to Captured.
@Controller('api/payments/psp')
export class PspWebhookController {
  private readonly logger = new Logger('PspWebhook');
  constructor(private readonly svc: PosTerminalService) {}

  @Public()
  @NoTx()
  @Post('webhook')
  webhook(
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Headers('x-psp-signature') signature: string | undefined,
    @Headers('x-psp-timestamp') timestamp: string | undefined,
    @Body(new ZodValidationPipe(WebhookBody)) b: z.infer<typeof WebhookBody>,
  ) {
    this.verifySignature(b.provider, req.rawBody, signature, timestamp);
    return this.svc.webhook(b.provider, b.provider_ref, b.status, b.event_id);
  }

  // Resolve the provider's webhook secret (PSP_WEBHOOK_SECRET_<PROVIDER>, else PSP_WEBHOOK_SECRET) and
  // verify the signature over the raw body. Fail closed when a secret IS configured and the signature is
  // missing/invalid. When NO secret is configured: reject in production (cannot authenticate the caller),
  // but allow in dev/test so mock/local flows work — mirroring the APP_ENC_KEY / JWT_SECRET gates.
  private verifySignature(provider: string, rawBody: Buffer | undefined, signature: string | undefined, timestamp?: string): void {
    const secret = process.env[`PSP_WEBHOOK_SECRET_${provider.toUpperCase()}`] ?? process.env.PSP_WEBHOOK_SECRET;
    if (!secret) {
      const env = process.env.NODE_ENV;
      if (env !== 'development' && env !== 'test') {
        throw new UnauthorizedException({ code: 'WEBHOOK_UNVERIFIED', message: 'PSP webhook secret not configured', messageTh: 'ยังไม่ได้ตั้งค่ารหัสยืนยัน webhook' });
      }
      this.logger.warn(`PSP webhook accepted UNVERIFIED for "${provider}" (no secret configured; dev/test only)`);
      return;
    }
    // Replay window (security review L-1): when the PSP sends x-psp-timestamp the signature must cover it and
    // it must be fresh; a replayed callback goes stale and is refused. No timestamp → body-only (back-compat).
    const tolerance = Number(process.env.PSP_WEBHOOK_TOLERANCE_SEC ?? 300);
    const result = verifyWebhookWithTimestamp(secret, rawBody ?? Buffer.from(''), signature, timestamp, tolerance);
    if (result === 'stale') {
      throw new UnauthorizedException({ code: 'WEBHOOK_STALE', message: 'PSP webhook timestamp outside the allowed window (possible replay)', messageTh: 'เวลาของ webhook หมดอายุ (อาจเป็นการส่งซ้ำ)' });
    }
    if (result !== 'ok') {
      throw new UnauthorizedException({ code: 'BAD_WEBHOOK_SIGNATURE', message: 'Invalid PSP webhook signature', messageTh: 'ลายเซ็น webhook ไม่ถูกต้อง' });
    }
  }
}

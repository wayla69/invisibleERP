import { Controller, Get, Post, Param, Body, Headers, Req } from '@nestjs/common';
import { z } from 'zod';
import { Public, NoTx } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { QrService } from './qr.service';
import { PublicOrderBody, StartBuffetBody, type PublicOrderDto, type StartBuffetDto } from './dto';

const ConfirmBody = z.object({ payment_no: z.string().min(1) });
const WebhookBody = z.object({ payment_no: z.string().min(1), status: z.string().optional() });

// PUBLIC diner endpoints — no login. @NoTx() opts out of the per-request tenant tx (which would set
// bypass_rls='on' for an anonymous request); the service sets app.tenant_id from the verified HMAC
// token instead, so RLS physically scopes every read/write to that one tenant.
@Controller('api/qr')
export class QrController {
  constructor(private readonly qr: QrService) {}

  @Public() @NoTx() @Post('start/:qrToken')
  start(@Param('qrToken') qrToken: string) { return this.qr.start(qrToken); }

  // Presence-bound rotating QR (#3): a short-TTL HMAC(tenant:table:window) token from a per-table display.
  @Public() @NoTx() @Post('rstart/:token')
  startRotating(@Param('token') token: string) { return this.qr.startRotating(token); }

  @Public() @NoTx() @Get('t/:token')
  status(@Param('token') token: string) { return this.qr.status(token); }

  @Public() @NoTx() @Get('t/:token/menu')
  menu(@Param('token') token: string) { return this.qr.menu(token); }

  @Public() @NoTx() @Post('t/:token/order')
  order(@Param('token') token: string, @Body(new ZodValidationPipe(PublicOrderBody)) b: PublicOrderDto) { return this.qr.order(token, b); }

  @Public() @NoTx() @Get('t/:token/buffet/tiers')
  buffetTiers(@Param('token') token: string) { return this.qr.buffetTiers(token); }

  @Public() @NoTx() @Post('t/:token/buffet/start')
  startBuffet(@Param('token') token: string, @Body(new ZodValidationPipe(StartBuffetBody)) b: StartBuffetDto) { return this.qr.startBuffet(token, b.package_id, b.pax); }

  @Public() @NoTx() @Post('t/:token/bill')
  bill(@Param('token') token: string) { return this.qr.requestBill(token); }

  @Public() @NoTx() @Post('t/:token/pay')
  pay(@Param('token') token: string) { return this.qr.pay(token); }

  @Public() @NoTx() @Post('t/:token/confirm')
  confirm(@Param('token') token: string, @Body(new ZodValidationPipe(ConfirmBody)) b: { payment_no: string }) { return this.qr.confirm(token, b.payment_no); }

  @Public() @NoTx() @Get('t/:token/payment-status')
  paymentStatus(@Param('token') token: string) { return this.qr.paymentStatus(token); }

  // PSP settlement webhook (real PromptPay) — static-secret OR additive HMAC-over-rawBody (constant-time,
  // replay window), fail-closed in prod, and single-shot per payment via the idempotency claim.
  @Public() @NoTx() @Post('webhook/promptpay')
  promptpayWebhook(
    @Req() req: { rawBody?: Buffer | string },
    @Headers('x-webhook-secret') secret: string | undefined,
    @Headers('x-webhook-signature') signature: string | undefined,
    @Headers('x-webhook-timestamp') timestamp: string | undefined,
    @Body(new ZodValidationPipe(WebhookBody)) b: z.infer<typeof WebhookBody>,
  ) {
    return this.qr.promptPayWebhook(b.payment_no, { secret, rawBody: req?.rawBody, signature, timestamp });
  }
}

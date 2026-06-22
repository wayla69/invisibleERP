import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, Public, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PosTerminalService } from './pos-terminal.service';

const TerminalBody = z.object({ terminal_code: z.string().min(1), name: z.string().optional(), provider: z.string().optional() });
const ChargeBody = z.object({ terminal_code: z.string().optional(), sale_no: z.string().optional(), amount: z.number().positive(), type: z.enum(['sale', 'preauth']).optional(), currency: z.string().optional(), token: z.string().optional() });
const CaptureBody = z.object({ amount: z.number().positive().optional() });
const RefundBody = z.object({ amount: z.number().positive() });
const SettleBody = z.object({ fee_pct: z.number().min(0).max(100).optional(), date: z.string().optional() });
const WebhookBody = z.object({ provider: z.string().min(1), provider_ref: z.string().min(1), status: z.string().min(1) });

@Controller('api/payments/terminal')
@Permissions('pos', 'order_mgt', 'creditors', 'exec')
export class PosTerminalController {
  constructor(private readonly svc: PosTerminalService) {}

  @Post('register') register(@Body(new ZodValidationPipe(TerminalBody)) b: z.infer<typeof TerminalBody>, @CurrentUser() u: JwtUser) { return this.svc.registerTerminal(b, u); }
  @Get('terminals') terminals() { return this.svc.listTerminals(); }

  @Post('charge') charge(@Body(new ZodValidationPipe(ChargeBody)) b: z.infer<typeof ChargeBody>, @CurrentUser() u: JwtUser) { return this.svc.charge(b, u); }
  @Post('intents/:intentNo/capture') capture(@Param('intentNo') no: string, @Body(new ZodValidationPipe(CaptureBody)) b: z.infer<typeof CaptureBody>, @CurrentUser() u: JwtUser) { return this.svc.capture(no, b.amount, u); }
  @Post('intents/:intentNo/void') voidIntent(@Param('intentNo') no: string) { return this.svc.voidIntent(no); }
  @Post('intents/:intentNo/refund') refund(@Param('intentNo') no: string, @Body(new ZodValidationPipe(RefundBody)) b: z.infer<typeof RefundBody>) { return this.svc.refundIntent(no, b.amount); }
  @Get('intents') intents(@Query('sale_no') saleNo?: string) { return this.svc.listIntents(saleNo); }

  @Post('settle') @Permissions('creditors', 'exec') settle(@Body(new ZodValidationPipe(SettleBody)) b: z.infer<typeof SettleBody>, @CurrentUser() u: JwtUser) { return this.svc.settle(b, u); }
  @Get('settlements') @Permissions('creditors', 'exec') settlements(@Query('limit') limit?: string) { return this.svc.listSettlements(limit ? +limit : 50); }
  @Post('settlements/:batchNo/reconcile') @Permissions('creditors', 'exec') reconcile(@Param('batchNo') no: string, @CurrentUser() u: JwtUser) { return this.svc.reconcile(no, u); }
}

// PSP callback — no JWT (HMAC verification belongs here for real providers).
@Controller('api/payments/psp')
export class PspWebhookController {
  constructor(private readonly svc: PosTerminalService) {}

  @Public()
  @Post('webhook')
  webhook(@Body(new ZodValidationPipe(WebhookBody)) b: z.infer<typeof WebhookBody>) { return this.svc.webhook(b.provider, b.provider_ref, b.status); }
}

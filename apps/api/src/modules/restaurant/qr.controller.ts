import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Public, NoTx } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { QrService } from './qr.service';

const ConfirmBody = z.object({ payment_no: z.string().min(1) });

// PUBLIC diner endpoints — no login. @NoTx() opts out of the per-request tenant tx (which would set
// bypass_rls='on' for an anonymous request); the service sets app.tenant_id from the verified HMAC
// token instead, so RLS physically scopes every read/write to that one tenant.
@Controller('api/qr')
export class QrController {
  constructor(private readonly qr: QrService) {}

  @Public() @NoTx() @Post('start/:qrToken')
  start(@Param('qrToken') qrToken: string) { return this.qr.start(qrToken); }

  @Public() @NoTx() @Get('t/:token')
  status(@Param('token') token: string) { return this.qr.status(token); }

  @Public() @NoTx() @Post('t/:token/bill')
  bill(@Param('token') token: string) { return this.qr.requestBill(token); }

  @Public() @NoTx() @Post('t/:token/pay')
  pay(@Param('token') token: string) { return this.qr.pay(token); }

  @Public() @NoTx() @Post('t/:token/confirm')
  confirm(@Param('token') token: string, @Body(new ZodValidationPipe(ConfirmBody)) b: { payment_no: string }) { return this.qr.confirm(token, b.payment_no); }
}

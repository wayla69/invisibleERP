import { Controller, Get, Post, Patch, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { qnum } from '../../common/query';
import {
  PaymentService,
  type RecordTenderDto,
  type RefundDto,
  type OpenTillDto,
  type CloseTillDto,
  type CashMovementDto,
} from './payments.service';

const TenderBody = z.object({
  sale_no: z.string().min(1),
  // tenant_id is intentionally NOT accepted from the body — it is derived from the authenticated user
  // server-side (a client must not be able to post a tender against another tenant).
  method: z.string().min(1),
  amount: z.number().positive(),
  tip: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  gateway: z.string().optional(),
  token: z.string().min(1).max(500).optional(),   // card token / wallet source from the terminal SDK
  till_session_id: z.number().optional(),
  // C1: a stable client token (e.g. a per-tender UUID). Retries with the same key return the original
  // tender instead of charging again. Optional so legacy/keyless callers keep working.
  idempotency_key: z.string().min(8).max(200).optional(),
});
const RefundBody = z.object({ payment_no: z.string().min(1), amount: z.number().positive(), reason: z.string().optional() });
const OpenTillBody = z.object({ opening_float: z.number().nonnegative().optional() });
const CloseTillBody = z.object({ session_no: z.string().min(1), closing_count: z.number().nonnegative(), denominations: z.record(z.string(), z.number()).optional() });
const CashMovementBody = z.object({ type: z.enum(['paid_in', 'paid_out', 'drop']), amount: z.number().positive(), reason: z.string().optional() });

@Controller('api/payments')
export class PaymentsController {
  constructor(private readonly svc: PaymentService) {}

  // Granular SoD sub-permissions: selling vs refund/void vs till are separable. Legacy holders of the
  // coarse 'pos' permission still pass (it implies pos_sell/pos_refund/pos_till); a single-duty Cashier
  // (pos_sell only) can tender but cannot refund/void or reconcile the drawer.
  @Post() @Permissions('pos_sell', 'cust_pos', 'ar')
  tender(@Body(new ZodValidationPipe(TenderBody)) b: RecordTenderDto, @CurrentUser() u: JwtUser) {
    return this.svc.recordTender(b, u);
  }

  @Post('refunds') @Permissions('pos_refund', 'ar')
  refund(@Body(new ZodValidationPipe(RefundBody)) b: RefundDto, @CurrentUser() u: JwtUser) {
    return this.svc.refund(b, u);
  }

  @Patch(':no/void') @Permissions('pos_refund', 'ar')
  void(@Param('no') no: string, @CurrentUser() u: JwtUser) {
    return this.svc.voidPayment(no, u);
  }

  // confirm an async tender (PromptPay/Authorized → Captured) once settlement is observed
  @Patch(':no/settle') @Permissions('pos_sell', 'ar')
  settle(@Param('no') no: string, @CurrentUser() u: JwtUser) {
    return this.svc.settle(no, u);
  }

  @Post('till/open') @Permissions('pos_till', 'ar')
  openTill(@Body(new ZodValidationPipe(OpenTillBody)) b: OpenTillDto, @CurrentUser() u: JwtUser) {
    return this.svc.openTill(b, u);
  }

  @Post('till/close') @Permissions('pos_till', 'ar')
  closeTill(@Body(new ZodValidationPipe(CloseTillBody)) b: CloseTillDto, @CurrentUser() u: JwtUser) {
    return this.svc.closeTill(b, u);
  }

  @Get() @Permissions('pos_sell', 'cust_pos', 'ar')
  list(@Query('sale_no') saleNo: string) {
    return this.svc.listPaymentsForSale(saleNo);
  }

  // scannable PromptPay QR for the tenant (before a tender is recorded) — POS shows it to the customer
  @Get('promptpay-qr') @Permissions('pos_sell', 'cust_pos', 'ar')
  promptPayQr(@Query('amount') amount: string, @CurrentUser() u: JwtUser) {
    return this.svc.promptPayQr(qnum('amount', amount), u);
  }

  // ── cash management: drawer movements + X/Z shift report (till duty: pos_till) ──
  @Post('till/:id/cash-movement') @Permissions('pos_till', 'ar')
  cashMovement(@Param('id') id: string, @Body(new ZodValidationPipe(CashMovementBody)) b: CashMovementDto, @CurrentUser() u: JwtUser) {
    return this.svc.recordCashMovement(Number(id), b, u);
  }

  @Get('till/:id/x-report') @Permissions('pos_till', 'ar')
  xReport(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.svc.xReport(Number(id), u);
  }

  @Get('till/:id/z-report') @Permissions('pos_till', 'ar')
  zReport(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    return this.svc.zReport(Number(id), u);
  }
}

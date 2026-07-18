import { Controller, Get, Post, Put, Patch, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { qnum } from '../../common/query';
import {
  PaymentService,
  type RecordTenderDto,
  type RefundDto,
  type OpenTillDto,
  type CloseTillDto,
  type TillSettingsDto,
  type CashMovementDto,
  type AdjustTipDto,
} from './payments.service';

const TenderBody = z.object({
  sale_no: z.string().min(1),
  // tenant_id is intentionally NOT accepted from the body — it is derived from the authenticated user
  // server-side (a client must not be able to post a tender against another tenant).
  method: z.string().min(1),
  amount: z.number().positive(),
  tip: z.number().nonnegative().optional(),
  cash_tendered: z.number().nonnegative().optional(),   // #1: cash handed over → change_due computed & recorded
  currency: z.string().optional(),
  gateway: z.string().optional(),
  token: z.string().min(1).max(500).optional(),   // card token / wallet source from the terminal SDK
  till_session_id: z.number().optional(),
  // C1: a stable client token (e.g. a per-tender UUID). Retries with the same key return the original
  // tender instead of charging again. Optional so legacy/keyless callers keep working.
  idempotency_key: z.string().min(8).max(200).optional(),
  // POS-10: auth-only (place a hold, capture later) — enables the tip-adjust-after-auth flow.
  authorize: z.boolean().optional(),
});
const AdjustTipBody = z.object({ tip: z.number().nonnegative(), reason: z.string().max(500).optional() });
const RefundBody = z.object({ payment_no: z.string().min(1), amount: z.number().positive(), reason: z.string().optional() });
const OpenTillBody = z.object({ opening_float: z.number().nonnegative().optional() });
const CloseTillBody = z.object({ session_no: z.string().min(1), closing_count: z.number().nonnegative(), denominations: z.record(z.string(), z.number()).optional() });
const TillSettingsBody = z.object({ blind_close: z.boolean().optional() });
const CashMovementBody = z.object({ type: z.enum(['paid_in', 'paid_out', 'drop']), amount: z.number().positive(), reason: z.string().optional() });
const RejectVarianceBody = z.object({ reason: z.string().max(500).optional() });
// Refund reject: the rejection reason + the (optional) SME self-approval justification (docs/49).
const RejectRefundBody = RejectVarianceBody.extend({ self_approval_reason: z.string().max(500).optional() });
const SignZBody = z.object({ denominations: z.record(z.string(), z.number()).optional() });

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

  // POS-10 — tip-adjust-after-auth. Staff set the tip the guest wrote on the slip on an AUTHORIZED tender
  // (pre-capture, up to the policy % ceiling — every adjustment audited), then capture bill + tip. A selling
  // duty (pos_sell) drives it; the ceiling + pre-capture + audit-log are the controls, not maker-checker.
  @Post(':no/tip-adjust') @Permissions('pos_sell', 'ar')
  adjustTip(@Param('no') no: string, @Body(new ZodValidationPipe(AdjustTipBody)) b: AdjustTipDto, @CurrentUser() u: JwtUser) {
    return this.svc.adjustTip(no, b, u);
  }

  @Post(':no/capture') @Permissions('pos_sell', 'ar')
  capture(@Param('no') no: string, @CurrentUser() u: JwtUser) {
    return this.svc.capture(no, u);
  }

  @Get(':no/tip-adjustments') @Permissions('pos_sell', 'pos_refund', 'exec', 'ar')
  tipAdjustments(@Param('no') no: string, @CurrentUser() u: JwtUser) {
    return this.svc.listTipAdjustments(no, u);
  }

  @Post('refunds') @Permissions('pos_refund', 'ar')
  refund(@Body(new ZodValidationPipe(RefundBody)) b: RefundDto, @CurrentUser() u: JwtUser) {
    return this.svc.refund(b, u);
  }

  // REV-16: a large refund parks as a request; a DIFFERENT user (manager) approves/rejects it (SoD).
  @Get('refund-requests') @Permissions('pos_refund', 'ar', 'exec')
  refundRequests(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listRefundRequests(status, u);
  }
  @Post('refund-requests/:id/approve') @Permissions('pos_refund', 'ar', 'exec')
  approveRefund(@Param('id') id: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.approveRefund(Number(id), u, b?.self_approval_reason);
  }
  @Post('refund-requests/:id/reject') @Permissions('pos_refund', 'ar', 'exec')
  rejectRefund(@Param('id') id: string, @Body(new ZodValidationPipe(RejectRefundBody)) b: { reason?: string; self_approval_reason?: string }, @CurrentUser() u: JwtUser) {
    return this.svc.rejectRefund(Number(id), u, b?.reason, b?.self_approval_reason);
  }

  // G14 (maker-checker audit — detective): void/refund exception report for independent periodic review.
  @Get('exceptions/voids-refunds') @Permissions('exec', 'ar', 'fin_report')
  voidRefundExceptions(@Query('from') from: string | undefined, @Query('to') to: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.voidRefundExceptions({ from, to }, u);
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

  // Read the caller's tenant's current open till (or null) — used by the POS login/register flow to avoid
  // opening a duplicate shift. Readable by any POS principal (selling or till duty).
  @Get('till/current') @Permissions('pos_till', 'pos_sell', 'cust_pos', 'ar')
  currentTill(@CurrentUser() u: JwtUser) {
    return this.svc.currentTill(u);
  }

  // Pending list — recent till sessions for the /pos/close-of-day Z-report dropdown (pick, don't type).
  @Get('till/sessions') @Permissions('pos_till', 'pos_close', 'ar')
  tillSessions(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listTillSessions(u, status);
  }

  @Post('till/close') @Permissions('pos_till', 'ar')
  closeTill(@Body(new ZodValidationPipe(CloseTillBody)) b: CloseTillDto, @CurrentUser() u: JwtUser) {
    return this.svc.closeTill(b, u);
  }

  // Blind drawer close policy (P1c, docs/50 Wave 1). Readable by any till principal (the register needs
  // to know whether to hide expected); changing the policy is manager-only (mirrors receiving-settings).
  @Get('till/settings') @Permissions('pos_till', 'pos_close', 'ar', 'exec')
  tillSettings_(@CurrentUser() u: JwtUser) {
    return this.svc.getTillSettings(u);
  }

  @Put('till/settings') @Permissions('ar', 'exec')
  putTillSettings(@Body(new ZodValidationPipe(TillSettingsBody)) b: TillSettingsDto, @CurrentUser() u: JwtUser) {
    return this.svc.putTillSettings(b, u);
  }

  // POS-01: a material cash over/short parked on close is cleared by a manager (maker-checker).
  // Approving/rejecting requires a DIFFERENT user than the cashier who closed (SoD, enforced in ledger).
  @Post('till/variance/:sessionNo/approve') @Permissions('pos_till', 'ar')
  approveVariance(@Param('sessionNo') sessionNo: string, @CurrentUser() u: JwtUser) {
    return this.svc.approveVariance(sessionNo, u);
  }

  @Post('till/variance/:sessionNo/reject') @Permissions('pos_till', 'ar')
  rejectVariance(@Param('sessionNo') sessionNo: string, @Body(new ZodValidationPipe(RejectVarianceBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) {
    return this.svc.rejectVariance(sessionNo, u, b?.reason);
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

  // ── POS-07: sign + archive the Z-report (manager attestation: pos_close) ──
  @Post('till/:sessionNo/z-report/sign') @Permissions('pos_close', 'ar')
  signZReport(@Param('sessionNo') sessionNo: string, @Body(new ZodValidationPipe(SignZBody)) b: { denominations?: Record<string, number> }, @CurrentUser() u: JwtUser) {
    return this.svc.signZReport(sessionNo, u, b.denominations);
  }

  @Get('xz-reports') @Permissions('pos_till', 'pos_close', 'ar')
  listXzReports(@CurrentUser() u: JwtUser, @Query('limit') limit?: string) {
    return this.svc.listXzReports(u, limit ? Math.min(200, Math.max(1, parseInt(limit, 10) || 50)) : 50);
  }

  @Get('xz-reports/:id') @Permissions('pos_till', 'pos_close', 'ar')
  getXzReport(@Param('id') id: string) {
    return this.svc.getXzReport(Number(id));
  }
}

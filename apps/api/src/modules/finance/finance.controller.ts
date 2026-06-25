import { Controller, Get, Post, Patch, Param, Query, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { FinanceService, type ReceiptDto, type ApTxnDto, type AdvanceDto, type SettleAdvanceDto } from './finance.service';
import { FinancialHealthService } from './financial-health.service';
import { qint, qintOpt } from '../../common/query';

const ReceiptBody = z.object({ invoice_no: z.string().min(1), amount: z.number().positive(), method: z.string().optional(), ref_no: z.string().optional(), remarks: z.string().optional(), idempotency_key: z.string().optional() });
const ApTxnBody = z.object({ vendor_id: z.number().optional(), vendor_name: z.string().optional(), txn_type: z.string().optional(), invoice_no: z.string().optional(), invoice_date: z.string().optional(), due_date: z.string().optional(), amount: z.number(), paid_amount: z.number().optional(), remarks: z.string().optional(), vat_treatment: z.enum(['standard', 'exempt', 'zero']).optional(), idempotency_key: z.string().optional() });
const PayBody = z.object({ amount: z.number().positive(), idempotency_key: z.string().optional() });
const RejectBody = z.object({ reason: z.string().optional() });
const AdvanceBody = z.object({ payee: z.string().min(1), amount: z.number().positive(), purpose: z.string().optional(), expense_account: z.string().optional(), tenant_id: z.number().optional() });
const SettleBody = z.object({ settled_expense: z.number().nonnegative(), returned_cash: z.number().nonnegative().optional(), expense_account: z.string().optional() });

@Controller('api/finance')
export class FinanceController {
  constructor(private readonly svc: FinanceService, private readonly health: FinancialHealthService) {}

  // Working-capital health score (0–100, A–E) from cash on hand + AR/AP + overdue + POS run-rate.
  // Complements the GL module's cash-flow projection (/api/ledger/cash-flow-forecast).
  @Get('health') @Permissions('exec', 'dashboard', 'ar', 'creditors')
  financialHealth(@CurrentUser() u: JwtUser) { return this.health.score(u); }

  // READ
  @Get('pl') @Permissions('exec', 'dashboard', 'ar', 'creditors')
  pl(@Query('month') month: string, @Query('year') year: string) { return this.svc.pl(parseInt(month, 10), parseInt(year, 10)); }

  @Get('ap') @Permissions('creditors', 'exec')
  ap(@Query('status') status = 'Outstanding', @Query('limit') limit?: string, @Query('offset') offset?: string) { return this.svc.ap(status, qint('limit', limit, 20), qint('offset', offset, 0)); }

  @Get('ar') @Permissions('ar', 'exec')
  ar(@Query('limit') limit?: string, @Query('offset') offset?: string) { return this.svc.ar(qint('limit', limit, 20), qint('offset', offset, 0)); }

  @Get('kpi') @Permissions('exec', 'dashboard')
  kpi() { return this.svc.kpi(); }

  @Get('ar/aging') @Permissions('ar', 'exec')
  arAging() { return this.svc.arAging(); }

  @Get('ap/aging') @Permissions('creditors', 'exec')
  apAging() { return this.svc.apAging(); }

  // sub-ledger ↔ GL reconciliation (AR 1100 == open AR, AP 2000 == open AP)
  @Get('reconciliation') @Permissions('exec', 'ar', 'creditors')
  reconciliation() { return this.svc.reconcile(); }

  // Statement of account — running balance over [from,to] for one customer (AR) or vendor (AP).
  @Get('ar/statement') @Permissions('ar', 'exec')
  customerStatement(@Query('tenant_id') tenantId: string, @Query('from') from?: string, @Query('to') to?: string) { return this.svc.customerStatement(Number(tenantId), from || undefined, to || undefined); }

  @Get('ap/statement') @Permissions('creditors', 'exec')
  vendorStatement(@Query('vendor') vendor: string, @Query('from') from?: string, @Query('to') to?: string) { return this.svc.vendorStatement(vendor, from || undefined, to || undefined); }

  // Petty cash / employee cash advances (EXP-07): issue a float, settle it against actual spend.
  @Post('advances') @Permissions('creditors', 'exec')
  issueAdvance(@Body(new ZodValidationPipe(AdvanceBody)) b: AdvanceDto, @CurrentUser() u: JwtUser) { return this.svc.issueAdvance(b, u); }

  @Post('advances/:advanceNo/settle') @HttpCode(200) @Permissions('creditors', 'exec')
  settleAdvance(@Param('advanceNo') advanceNo: string, @Body(new ZodValidationPipe(SettleBody)) b: SettleAdvanceDto, @CurrentUser() u: JwtUser) { return this.svc.settleAdvance(advanceNo, b, u); }

  @Get('advances') @Permissions('creditors', 'exec')
  advances(@Query('tenant_id') tenantId?: string, @Query('status') status?: string) { return this.svc.listAdvances(tenantId ? Number(tenantId) : undefined, status || undefined); }

  // WRITE
  @Post('ar/sync') @Permissions('ar')
  syncAr(@CurrentUser() u: JwtUser) { return this.svc.syncArInvoices(u); }

  @Post('ar/receipts') @Permissions('ar')
  receipt(@Body(new ZodValidationPipe(ReceiptBody)) b: ReceiptDto, @CurrentUser() u: JwtUser) { return this.svc.createReceipt(b, u); }

  @Post('ap/transactions') @Permissions('creditors')
  apTxn(@Body(new ZodValidationPipe(ApTxnBody)) b: ApTxnDto, @CurrentUser() u: JwtUser) { return this.svc.createApTxn(b, u); }

  // AP disbursement maker-checker (AP-PAY). MAKER requests; a DIFFERENT user with approval authority approves.
  // Request a payment (maker). Records a PendingApproval row — no cash/GL effect until approved.
  @Patch('ap/transactions/:txnNo/pay') @Permissions('creditors')
  requestApPayment(@Param('txnNo') txnNo: string, @Body(new ZodValidationPipe(PayBody)) b: { amount: number; idempotency_key?: string }, @CurrentUser() u: JwtUser) { return this.svc.requestApPayment(txnNo, b.amount, u, b.idempotency_key); }

  // Checker queue — payments awaiting approval.
  @Get('ap/payments/pending') @Permissions('approvals', 'gl_close', 'exec')
  pendingApPayments(@Query('limit') limit?: string, @Query('offset') offset?: string) { return this.svc.listPendingApPayments(qint('limit', limit, 50), qint('offset', offset, 0)); }

  // Approve a pending payment (checker; approver ≠ requester enforced in the service, even for Admin).
  @Post('ap/payments/:paymentNo/approve') @HttpCode(200) @Permissions('approvals', 'gl_close')
  approveApPayment(@Param('paymentNo') paymentNo: string, @CurrentUser() u: JwtUser) { return this.svc.approveApPayment(paymentNo, u); }

  // Reject a pending payment (checker).
  @Post('ap/payments/:paymentNo/reject') @HttpCode(200) @Permissions('approvals', 'gl_close')
  rejectApPayment(@Param('paymentNo') paymentNo: string, @Body(new ZodValidationPipe(RejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.rejectApPayment(paymentNo, u, b.reason); }
}

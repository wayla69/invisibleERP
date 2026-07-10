import { Controller, Get, Post, Patch, Param, Query, Body, HttpCode, Res } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { FinanceService, type ReceiptDto, type ApTxnDto, type AdvanceDto, type SettleAdvanceDto } from './finance.service';
import { FinancialHealthService } from './financial-health.service';
import { ArAllowanceService, type ComputeAllowanceDto } from './ar-allowance.service';
import { ArCashApplicationService, type CashApplicationDto, type ApplyOnAccountDto } from './ar-cash-application.service';
import { ApPaymentRunService, type ProposeRunDto, type EditRunLinesDto } from './ap-payment-run.service';
import { qint, qintOpt } from '../../common/query';

const ReceiptBody = z.object({ invoice_no: z.string().min(1), amount: z.number().positive(), method: z.string().optional(), ref_no: z.string().optional(), remarks: z.string().optional(), idempotency_key: z.string().optional() });
const ApTxnBody = z.object({ vendor_id: z.number().optional(), vendor_name: z.string().optional(), txn_type: z.string().optional(), invoice_no: z.string().optional(), invoice_date: z.string().optional(), due_date: z.string().optional(), amount: z.number(), paid_amount: z.number().optional(), remarks: z.string().optional(), vat_treatment: z.enum(['standard', 'exempt', 'zero', 'reverse_charge']).optional(), tax_code: z.string().optional(), idempotency_key: z.string().optional() });
const PayBody = z.object({ amount: z.number().positive(), idempotency_key: z.string().optional(), wht_income_type: z.string().optional(), wht_rate: z.number().min(0).max(0.30).optional(), wht_tax_code: z.string().optional() });
const RejectBody = z.object({ reason: z.string().optional() });
const AdvanceBody = z.object({ payee: z.string().min(1), amount: z.number().positive(), purpose: z.string().optional(), expense_account: z.string().optional(), tenant_id: z.number().optional(), project_code: z.string().optional(), boq_line_id: z.number().int().positive().optional() });
const SettleBody = z.object({ settled_expense: z.number().nonnegative(), returned_cash: z.number().nonnegative().optional(), expense_account: z.string().optional() });
const WriteOffBody = z.object({ tenant_id: z.number().optional(), customer_name: z.string().optional(), amount: z.number().positive(), reason: z.string().min(1) });
// to_email optional — when omitted the service defaults the recipient to the counterparty's email on file
// (master data: the customer for the AR invoice / statement / receipt).
const DocEmailBody = z.object({ to_email: z.string().email().optional() });
// AR cash application (REV-21) — one receipt across many invoices; remainder parks on-account.
const CashAppLine = z.object({ invoice_no: z.string().min(1), amount: z.number().positive() });
const CashApplicationBody = z.object({
  customer_no: z.union([z.string().min(1), z.number()]),
  amount: z.number().nonnegative().optional(),
  method: z.string().optional(), ref_no: z.string().optional(), remarks: z.string().optional(), idempotency_key: z.string().optional(),
  lines: z.array(CashAppLine).optional(),
  credit_notes: z.array(z.object({ doc_no: z.string().min(1), invoice_no: z.string().min(1), amount: z.number().positive() })).optional(),
});
const ApplyOnAccountBody = z.object({ receipt_ref: z.string().min(1), lines: z.array(CashAppLine).min(1) });
const ReverseBody = z.object({ reason: z.string().min(1) });
// AP payment run (EXP-13): propose (due-date selection) → edit while Draft → submit → approve/reject
// (distinct approver) → execute (existing per-payment path) → bank bulk-transfer file.
const ProposeRunBody = z.object({
  due_cutoff: z.string().min(1),
  pay_date: z.string().optional(),
  bank_account_id: z.number().int().positive(),
  vendor_ids: z.array(z.number().int().positive()).optional(),
  vendor_name: z.string().optional(),
  early_pay_window_days: z.number().int().min(0).max(60).optional(),
  wht_tax_code: z.string().optional(),
  remarks: z.string().optional(),
});
const EditRunLinesBody = z.object({
  remove_line_ids: z.array(z.number().int().positive()).optional(),
  update: z.array(z.object({
    line_id: z.number().int().positive(),
    amount: z.number().positive().optional(),
    wht_tax_code: z.string().nullable().optional(),
    wht_rate: z.number().min(0).max(0.30).nullable().optional(),
    wht_income_type: z.string().nullable().optional(),
  })).optional(),
});
const AllowanceComputeBody = z.object({
  as_of_date: z.string().optional(),
  method: z.enum(['aging', 'percentage']).optional(),
  flat_rate: z.number().min(0).max(1).optional(),
  bucket_rates: z.object({ current: z.number().min(0).max(1).optional(), d1_30: z.number().min(0).max(1).optional(), d31_60: z.number().min(0).max(1).optional(), d61_90: z.number().min(0).max(1).optional(), d91_120: z.number().min(0).max(1).optional(), d120_plus: z.number().min(0).max(1).optional() }).optional(),
  tenant_id: z.number().nullable().optional(),
});

@Controller('api/finance')
export class FinanceController {
  constructor(private readonly svc: FinanceService, private readonly health: FinancialHealthService, private readonly allowance: ArAllowanceService, private readonly cashApp: ArCashApplicationService, private readonly payRuns: ApPaymentRunService) {}

  // ── AR cash application (REV-21) — multi-invoice receipt application + on-account cash ──
  // Worksheet feed: open invoices (with pending-committed amounts), unapplied receipts, applicable credit notes.
  @Get('ar/open-items') @Permissions('ar', 'exec')
  arOpenItems(@Query('customer_no') customerNo: string) { return this.cashApp.openItems(customerNo); }

  // Deterministic auto-suggest: exact single-invoice match, else oldest-due-first allocation.
  @Get('ar/cash-application/suggest') @Permissions('ar', 'exec')
  suggestCashApplication(@Query('customer_no') customerNo?: string, @Query('amount') amount?: string, @Query('receipt_ref') receiptRef?: string) {
    return this.cashApp.suggest({ customer_no: customerNo || undefined, amount: amount ? Number(amount) : undefined, receipt_ref: receiptRef || undefined });
  }

  // The application register / pending queue (declared before the :param POST routes for clarity only).
  @Get('ar/cash-application') @Permissions('ar', 'exec', 'approvals')
  listCashApplications(@Query('status') status?: string, @Query('invoice_no') invoiceNo?: string, @Query('receipt_no') receiptNo?: string, @Query('limit') limit?: string) {
    return this.cashApp.listApplications({ status: status || undefined, invoice_no: invoiceNo || undefined, receipt_no: receiptNo || undefined, limit: limit ? Number(limit) : undefined });
  }

  // Post a worksheet: one receipt across many invoices (+ credit-note lines); remainder parks on-account.
  // A batch at/over the threshold parks PendingApproval for a DIFFERENT approver (mirrors REV-16).
  @Post('ar/cash-application') @Permissions('ar')
  createCashApplication(@Body(new ZodValidationPipe(CashApplicationBody)) b: CashApplicationDto, @CurrentUser() u: JwtUser) { return this.cashApp.createCashApplication(b, u); }

  // Apply parked on-account cash to invoices later (same validations + threshold).
  @Post('ar/apply-on-account') @HttpCode(200) @Permissions('ar')
  applyOnAccount(@Body(new ZodValidationPipe(ApplyOnAccountBody)) b: ApplyOnAccountDto, @CurrentUser() u: JwtUser) { return this.cashApp.applyOnAccount(b, u); }

  // Checker approves/rejects a parked batch (approver ≠ poster enforced in the service, even for Admin).
  @Post('ar/cash-application/:batchNo/approve') @HttpCode(200) @Permissions('approvals', 'gl_close')
  approveCashApplication(@Param('batchNo') batchNo: string, @CurrentUser() u: JwtUser) { return this.cashApp.approveBatch(batchNo, u); }

  @Post('ar/cash-application/:batchNo/reject') @HttpCode(200) @Permissions('approvals', 'gl_close')
  rejectCashApplication(@Param('batchNo') batchNo: string, @Body(new ZodValidationPipe(RejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.cashApp.rejectBatch(batchNo, u, b.reason); }

  // Audited reversal of a single application line (reason REQUIRED; cash returns to on-account).
  @Post('ar/cash-application/:applicationNo/reverse') @HttpCode(200) @Permissions('ar', 'exec')
  reverseCashApplication(@Param('applicationNo') applicationNo: string, @Body(new ZodValidationPipe(ReverseBody)) b: { reason: string }, @CurrentUser() u: JwtUser) { return this.cashApp.reverseApplication(applicationNo, b.reason, u); }

  // REV-18 — AR Allowance for Doubtful Accounts (ECL). Compute an aging-driven provision (maker), then a
  // DIFFERENT user posts the delta to GL (Dr 5720 / Cr 1190).
  @Post('ar-allowance/compute') @HttpCode(200) @Permissions('creditors', 'ar', 'gl_post', 'exec')
  computeAllowance(@Body(new ZodValidationPipe(AllowanceComputeBody)) b: ComputeAllowanceDto, @CurrentUser() u: JwtUser) { return this.allowance.computeAllowance(b, u); }

  @Post('ar-allowance/:id/post') @HttpCode(200) @Permissions('gl_post', 'exec')
  postAllowance(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.allowance.postAllowance(Number(id), u); }

  @Get('ar-allowance') @Permissions('creditors', 'ar', 'gl_post', 'exec')
  listAllowance(@Query('tenant_id') tenantId?: string, @CurrentUser() u?: JwtUser) { return this.allowance.list(tenantId ? Number(tenantId) : (u?.tenantId ?? undefined)); }

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

  // REC-04 — period-end control-account reconciliation pack (AR/AP/Inventory/Gift cards/Deferred revenue ↔ GL).
  @Get('reconciliation/controls') @Permissions('exec', 'ar', 'creditors')
  reconciliationControls() { return this.svc.reconcileControls(); }

  // GOV-01 — unified pending-approvals monitor across every maker-checker
  // (GL-05/BANK-02/EXP-06/PAY-03/FA-08/FA-09/INV-07/FX-04/BUD-01).
  @Get('approvals/pending') @Permissions('exec', 'approvals', 'creditors')
  pendingApprovals(@Query('overdue_days') overdueDays?: string) {
    return this.svc.pendingApprovals({ overdue_days: overdueDays ? Math.max(1, Number(overdueDays) || 3) : undefined });
  }

  // Statement of account — running balance over [from,to] for one customer (AR) or vendor (AP).
  @Get('ar/statement') @Permissions('ar', 'exec')
  customerStatement(@Query('tenant_id') tenantId: string, @Query('from') from?: string, @Query('to') to?: string, @Query('currency') currency?: string) { return this.svc.customerStatement(Number(tenantId), from || undefined, to || undefined, currency || undefined); }

  @Get('ap/statement') @Permissions('creditors', 'exec')
  vendorStatement(@Query('vendor') vendor: string, @Query('from') from?: string, @Query('to') to?: string, @Query('currency') currency?: string) { return this.svc.vendorStatement(vendor, from || undefined, to || undefined, currency || undefined); }

  // Printable ใบแจ้งยอดบัญชี (Statement of account) — customer (AR) / vendor (AP) — HTML→PDF, HTML fallback.
  @Get('ar/statement/pdf') @Permissions('ar', 'exec')
  async customerStatementPdf(@Query('tenant_id') tenantId: string, @Query('from') from: string | undefined, @Query('to') to: string | undefined, @Query('currency') currency: string | undefined, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const s = await this.svc.getCustomerStatementForPrint(Number(tenantId), from || undefined, to || undefined, currency || undefined, u);
    const buf = await this.svc.renderStatementPdf(s);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="statement-${tenantId}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(this.svc.statementHtml(s));
  }
  @Post('ar/statement/send-email') @HttpCode(200) @Permissions('ar', 'exec')
  async emailCustomerStatement(@Query('tenant_id') tenantId: string, @Query('from') from: string | undefined, @Query('to') to: string | undefined, @Query('currency') currency: string | undefined, @Body(new ZodValidationPipe(DocEmailBody)) b: z.infer<typeof DocEmailBody>, @CurrentUser() u: JwtUser) {
    return this.svc.emailStatement(await this.svc.getCustomerStatementForPrint(Number(tenantId), from || undefined, to || undefined, currency || undefined, u), b.to_email);
  }
  @Get('ap/statement/pdf') @Permissions('creditors', 'exec')
  async vendorStatementPdf(@Query('vendor') vendor: string, @Query('from') from: string | undefined, @Query('to') to: string | undefined, @Query('currency') currency: string | undefined, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const s = await this.svc.getVendorStatementForPrint(vendor, from || undefined, to || undefined, currency || undefined, u);
    const buf = await this.svc.renderStatementPdf(s);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="statement-vendor.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(this.svc.statementHtml(s));
  }

  // Recent AR receipts — the finance list surface (print/email each ใบสำคัญรับเงิน).
  // Declared before `ar/receipts/:receiptNo/pdf` so the literal `receipts` is never captured as a receiptNo.
  @Get('ar/receipts') @Permissions('ar', 'exec')
  listArReceipts(@Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listArReceipts(u, limit ? Number(limit) : 50); }

  // Printable ใบสำคัญรับเงิน (AR receipt voucher).
  @Get('ar/receipts/:receiptNo/pdf') @Permissions('ar', 'exec')
  async arReceiptPdf(@Param('receiptNo') receiptNo: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const r = await this.svc.getArReceiptForPrint(receiptNo, u);
    const buf = await this.svc.renderArReceiptPdf(r);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${receiptNo}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(this.svc.arReceiptHtml(r));
  }
  @Post('ar/receipts/:receiptNo/send-email') @HttpCode(200) @Permissions('ar', 'exec')
  emailArReceipt(@Param('receiptNo') receiptNo: string, @Body(new ZodValidationPipe(DocEmailBody)) b: z.infer<typeof DocEmailBody>, @CurrentUser() u: JwtUser) {
    return this.svc.emailArReceipt(receiptNo, b.to_email, u);
  }

  // Printable ใบแจ้งหนี้/ใบวางบิล (AR billing invoice) — HTML→PDF via the shared renderer (HTML fallback
  // when Chromium absent). Distinct from the statutory ใบกำกับภาษี under /api/tax-invoices.
  @Get('ar/invoices/:invoiceNo/pdf') @Permissions('ar', 'exec')
  async arInvoicePdf(@Param('invoiceNo') invoiceNo: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const inv = await this.svc.getArInvoiceForPrint(invoiceNo, u);
    const html = this.svc.arInvoiceHtml(inv);
    const buf = await this.svc.renderArInvoicePdf(inv);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="${invoiceNo}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  }

  // Email the ใบแจ้งหนี้ to the customer as a PDF attachment.
  @Post('ar/invoices/:invoiceNo/send-email') @HttpCode(200) @Permissions('ar', 'exec')
  emailArInvoice(@Param('invoiceNo') invoiceNo: string, @Body(new ZodValidationPipe(DocEmailBody)) b: z.infer<typeof DocEmailBody>, @CurrentUser() u: JwtUser) {
    return this.svc.emailArInvoice(invoiceNo, b.to_email, u);
  }

  // Petty cash / employee cash advances (EXP-07): issue a float, settle it against actual spend.
  @Post('advances') @Permissions('creditors', 'exec')
  issueAdvance(@Body(new ZodValidationPipe(AdvanceBody)) b: AdvanceDto, @CurrentUser() u: JwtUser) { return this.svc.issueAdvance(b, u); }

  @Post('advances/:advanceNo/settle') @HttpCode(200) @Permissions('creditors', 'exec')
  settleAdvance(@Param('advanceNo') advanceNo: string, @Body(new ZodValidationPipe(SettleBody)) b: SettleAdvanceDto, @CurrentUser() u: JwtUser) { return this.svc.settleAdvance(advanceNo, b, u); }

  @Get('advances') @Permissions('creditors', 'exec')
  advances(@Query('tenant_id') tenantId?: string, @Query('status') status?: string) { return this.svc.listAdvances(tenantId ? Number(tenantId) : undefined, status || undefined); }

  // AR bad-debt write-off (REV-14): maker requests; a different user approves via POST /api/ledger/journal/:entryNo/approve.
  @Post('ar/write-off') @Permissions('ar', 'exec')
  writeOffAr(@Body(new ZodValidationPipe(WriteOffBody)) b: z.infer<typeof WriteOffBody>, @CurrentUser() u: JwtUser) { return this.svc.writeOffAr(b, u); }

  @Get('ar/write-offs') @Permissions('ar', 'exec', 'approvals')
  writeOffs(@Query('tenant_id') tenantId?: string) { return this.svc.listWriteOffs(tenantId ? Number(tenantId) : undefined); }

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
  requestApPayment(@Param('txnNo') txnNo: string, @Body(new ZodValidationPipe(PayBody)) b: { amount: number; idempotency_key?: string; wht_income_type?: string; wht_rate?: number; wht_tax_code?: string }, @CurrentUser() u: JwtUser) { return this.svc.requestApPayment(txnNo, b.amount, u, b.idempotency_key, { income_type: b.wht_income_type, rate: b.wht_rate, tax_code: b.wht_tax_code }); }

  // Checker queue — payments awaiting approval.
  @Get('ap/payments/pending') @Permissions('approvals', 'gl_close', 'exec')
  pendingApPayments(@Query('limit') limit?: string, @Query('offset') offset?: string) { return this.svc.listPendingApPayments(qint('limit', limit, 50), qint('offset', offset, 0)); }

  // Approve a pending payment (checker; approver ≠ requester enforced in the service, even for Admin).
  @Post('ap/payments/:paymentNo/approve') @HttpCode(200) @Permissions('approvals', 'gl_close')
  approveApPayment(@Param('paymentNo') paymentNo: string, @CurrentUser() u: JwtUser) { return this.svc.approveApPayment(paymentNo, u); }

  // Reject a pending payment (checker).
  @Post('ap/payments/:paymentNo/reject') @HttpCode(200) @Permissions('approvals', 'gl_close')
  rejectApPayment(@Param('paymentNo') paymentNo: string, @Body(new ZodValidationPipe(RejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.rejectApPayment(paymentNo, u, b.reason); }

  // ── AP payment run + Thai bank payment file (EXP-13) ──
  // MAKER (`creditors`) proposes a batch of open approved AP by due-date cutoff (every line re-passes the
  // 3-way-match gate, EXP-09), edits lines only while Draft, then submits; a DIFFERENT user with the same
  // approval authority as a manual AP payment (`approvals`/`gl_close`) approves (self-approval →
  // SOD_VIOLATION) and executes — each line posts through the EXISTING requestApPayment→approveApPayment
  // path (identical GL + WHT postings; idempotent per line). The bank bulk-transfer file's SHA-256 is
  // pinned on the run + status-logged; bank-statement auto-match clears the lines (see BankService).
  @Post('ap/payment-runs/propose') @Permissions('creditors')
  proposePaymentRun(@Body(new ZodValidationPipe(ProposeRunBody)) b: ProposeRunDto, @CurrentUser() u: JwtUser) { return this.payRuns.propose(b, u); }

  @Get('ap/payment-runs') @Permissions('creditors', 'approvals', 'gl_close', 'exec')
  listPaymentRuns(@Query('status') status: string | undefined, @Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) { return this.payRuns.list(u, status || undefined, limit ? qint('limit', limit, 50) : 50); }

  @Get('ap/payment-runs/:runNo') @Permissions('creditors', 'approvals', 'gl_close', 'exec')
  getPaymentRun(@Param('runNo') runNo: string) { return this.payRuns.get(runNo); }

  @Patch('ap/payment-runs/:runNo/lines') @Permissions('creditors')
  editPaymentRunLines(@Param('runNo') runNo: string, @Body(new ZodValidationPipe(EditRunLinesBody)) b: EditRunLinesDto, @CurrentUser() u: JwtUser) { return this.payRuns.editLines(runNo, b, u); }

  @Post('ap/payment-runs/:runNo/submit') @HttpCode(200) @Permissions('creditors')
  submitPaymentRun(@Param('runNo') runNo: string, @CurrentUser() u: JwtUser) { return this.payRuns.submit(runNo, u); }

  @Post('ap/payment-runs/:runNo/approve') @HttpCode(200) @Permissions('approvals', 'gl_close')
  approvePaymentRun(@Param('runNo') runNo: string, @CurrentUser() u: JwtUser) { return this.payRuns.approve(runNo, u); }

  @Post('ap/payment-runs/:runNo/reject') @HttpCode(200) @Permissions('approvals', 'gl_close')
  rejectPaymentRun(@Param('runNo') runNo: string, @Body(new ZodValidationPipe(RejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.payRuns.reject(runNo, u, b.reason); }

  @Post('ap/payment-runs/:runNo/cancel') @HttpCode(200) @Permissions('creditors', 'exec')
  cancelPaymentRun(@Param('runNo') runNo: string, @CurrentUser() u: JwtUser) { return this.payRuns.cancel(runNo, u); }

  @Post('ap/payment-runs/:runNo/execute') @HttpCode(200) @Permissions('approvals', 'gl_close')
  executePaymentRun(@Param('runNo') runNo: string, @CurrentUser() u: JwtUser) { return this.payRuns.execute(runNo, u); }

  // Thai bank bulk-transfer file (generic CSV + scb|kbank|bbl presets, or minimal ISO 20022 pain.001 XML).
  // The file's SHA-256 is recorded on the run and status-logged (audit evidence).
  @Get('ap/payment-runs/:runNo/bank-file') @Permissions('creditors', 'approvals', 'gl_close', 'exec')
  async paymentRunBankFile(@Param('runNo') runNo: string, @Query('format') format: string | undefined, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const f = await this.payRuns.bankFile(runNo, format, u);
    reply.header('Content-Type', f.contentType)
      .header('Content-Disposition', `attachment; filename="${f.filename}"`)
      .header('X-Content-Sha256', f.sha256)
      .send(f.body);
  }
}

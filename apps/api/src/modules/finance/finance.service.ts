import { Inject, Injectable, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { sql, eq, ne, and, gte, lt, asc, desc, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, apTransactions, apPayments, arInvoices, arReceipts, arReceiptApplications, tenants, invBalances, giftCards, revRecLines, journalEntries, journalLines, nettingSettlements } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { AccountDeterminationService } from '../ledger/account-determination.service';
import { TaxService } from '../tax/tax.service';
import { ThreeWayMatchService } from '../match/three-way-match.service';
import { CommitmentsService } from '../commitments/commitments.service';
import { ymd, monthStart, n, fx } from '../../database/queries';
import { ArInvoicePdfService, type ArInvoicePrintData } from './ar-invoice-pdf.service';
import { FinanceDocsPdfService, type StatementPrintData, type ArReceiptPrintData } from './finance-docs-pdf.service';
import { DocEmailService } from '../mail/doc-email.service';
import { FinanceDocumentsService } from './finance-documents.service';
import { FinanceAdvancesService } from './finance-advances.service';
import { FinanceApService } from './finance-ap.service';
import { FinanceArService } from './finance-ar.service';
import type { JwtUser } from '../../common/decorators';
import { approvalAgeDays, type ApprovalQueue, type ApprovalQueueSource } from '../../common/approval-queues';

export interface ReceiptDto { invoice_no: string; amount: number; method?: string; ref_no?: string; remarks?: string; idempotency_key?: string }
export interface ApTxnDto { vendor_id?: number; vendor_name?: string; txn_type?: string; invoice_no?: string; invoice_date?: string; due_date?: string; amount: number; paid_amount?: number; remarks?: string; vat_treatment?: 'standard' | 'exempt' | 'zero' | 'reverse_charge'; tax_code?: string; idempotency_key?: string; expense_account?: string; tenant_id?: number | null }
export interface AdvanceDto { payee: string; amount: number; purpose?: string; expense_account?: string; tenant_id?: number | null; project_code?: string; boq_line_id?: number }
export interface SettleAdvanceDto { settled_expense: number; returned_cash?: number; expense_account?: string }
// project_code (M4, docs/32) — an advance can be raised against a project so site cash is managed on it.

@Injectable()
export class FinanceService {
  private readonly documents: FinanceDocumentsService;
  private readonly advances: FinanceAdvancesService;
  private readonly apSvc: FinanceApService;
  private readonly arSvc: FinanceArService;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    // optional + last so the writeflow harness (which constructs FinanceService by hand with 3 args)
    // still compiles; when absent, GL posting is skipped (sub-ledger behaviour unchanged).
    @Optional() private readonly ledger?: LedgerService,
    @Optional() private readonly tax?: TaxService,
    @Optional() private readonly matchSvc?: ThreeWayMatchService, // Phase 16 — gates AP pay on 3-way match
    @Optional() private readonly commitments?: CommitmentsService, // FU1 (docs/32) — site cash consumes BoQ budget
    // docs/33 PR6 — resolve the VAT leg (rate + output/input GL account) from a tax_code. Optional so the
    // writeflow harness's hand-constructed FinanceService still builds; absent ⇒ the flat 7/107→2100 default.
    @Optional() private readonly determination?: AccountDeterminationService,
    // Printable ใบแจ้งหนี้/ใบวางบิล + generic document email. @Optional so hand-constructed harnesses build.
    @Optional() private readonly arInvoicePdf?: ArInvoicePdfService,
    @Optional() private readonly docEmail?: DocEmailService,
    @Optional() private readonly finDocsPdf?: FinanceDocsPdfService, // statement + AR receipt voucher renderers
  ) {
    this.documents = new FinanceDocumentsService(db, arInvoicePdf, docEmail, finDocsPdf);
    this.advances = new FinanceAdvancesService(db, docNo, ledger, commitments);
    this.apSvc = new FinanceApService(db, docNo, statusLog, (g) => this.vatSplit(g), (t, c, a, s, o) => this.vatLegFromCode(t, c, a, s, o), ledger, matchSvc, determination);
    this.arSvc = new FinanceArService(db, docNo, statusLog, (g) => this.vatSplit(g), (t, c, a, s, o) => this.vatLegFromCode(t, c, a, s, o), (t, i) => this.resolveOrderProfile(t, i), ledger, determination);
  }

  // VAT back-out (7/107) — prefer TaxService.calcInclusive when injected
  private vatSplit(gross: number): { net: number; vat: number } {
    if (this.tax) { const r = this.tax.calcInclusive({ gross }); return { net: r.net, vat: r.tax }; }
    const vat = Math.round((gross * 7 / 107) * 100) / 100;
    return { net: Math.round((gross - vat) * 100) / 100, vat };
  }

  // docs/33 PR6 — resolve a VAT leg (net/vat/gross + GL account) from a configured tax_code. `side` picks the
  // sales (output) vs purchase (input) VAT account. Honors the code's `inclusive` flag: inclusive ⇒ `amount`
  // is gross and VAT is backed out; exclusive ⇒ `amount` is net and gross = net + VAT. Returns null when no
  // code is given (caller keeps its flat default). An explicitly-given code that doesn't resolve to an active
  // VAT code fails closed (UNKNOWN_TAX_CODE / NOT_A_VAT_CODE) — the account itself is validated postable at
  // setup time and again by LedgerService.postEntry, so a bad account can never reach the books.
  private async vatLegFromCode(tenantId: number | null, code: string | null | undefined, amount: number, side: 'output' | 'input', opts?: { forceInclusive?: boolean }): Promise<{ net: number; vat: number; gross: number; account: string } | null> {
    if (!code || !this.determination) return null;
    const tc = await this.determination.resolveTaxCode(tenantId, code);
    if (!tc) throw new BadRequestException({ code: 'UNKNOWN_TAX_CODE', message: `Tax code '${code}' not found or inactive`, messageTh: `ไม่พบรหัสภาษี '${code}' หรือถูกปิดใช้งาน` });
    if (tc.kind !== 'vat') throw new BadRequestException({ code: 'NOT_A_VAT_CODE', message: `Tax code '${code}' is a ${tc.kind} code, not VAT`, messageTh: `รหัสภาษี '${code}' ไม่ใช่ภาษีมูลค่าเพิ่ม` });
    const rate = n(tc.rate);
    const account = (side === 'output' ? tc.outputAccount : tc.inputAccount) ?? '2100';
    // AR (forceInclusive) always treats `amount` as the fixed gross receivable and backs VAT out; AP honors
    // the code's inclusive/exclusive convention (exclusive ⇒ amount is net, gross = net + VAT).
    const inclusive = opts?.forceInclusive || tc.inclusive;
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const net = inclusive ? r2(amount - amount * rate / (1 + rate)) : r2(amount);
    const vat = inclusive ? r2(amount * rate / (1 + rate)) : r2(amount * rate);
    return { net, vat, gross: r2(net + vat), account };
  }

  // docs/33 PR6/PR7 — the VAT code + revenue account shared by ALL of an order's items (item → category
  // resolution). A field is null when the tenant hasn't opted in, an item leaves it blank, or the order MIXES
  // values (→ caller keeps its default). Resolves each item once.
  private async resolveOrderProfile(tenantId: number, itemIds: string[]): Promise<{ vatCode: string | null; revenueAccount: string | null }> {
    if (!this.determination || !itemIds.length) return { vatCode: null, revenueAccount: null };
    const vats = new Set<string | null>(), revs = new Set<string | null>();
    for (const id of new Set(itemIds)) {
      const r = await this.determination.resolveItemAccounts(tenantId, id);
      vats.add(r.vatCode ?? null); revs.add(r.revenueAccount ?? null);
    }
    const uniform = (s: Set<string | null>) => (s.size === 1 ? ([...s][0] ?? null) : null);
    return { vatCode: uniform(vats), revenueAccount: uniform(revs) };
  }

  // ───────────────────── READ (Phase 2) ─────────────────────
  async pl(month: number, year: number) {
    const db = this.db;
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const end = month < 12 ? `${year}-${String(month + 1).padStart(2, '0')}-01` : `${year}-12-31`;
    const inWin = and(ne(custPosSales.status, 'Voided'), gte(custPosSales.saleDate, start), lt(custPosSales.saleDate, end));
    const [p] = await db.select({
      revenue: sql<string>`coalesce(sum(${custPosSales.subtotal}),0)`, discounts: sql<string>`coalesce(sum(${custPosSales.discount}),0)`,
      tax_collected: sql<string>`coalesce(sum(${custPosSales.taxAmount}),0)`, net_revenue: sql<string>`coalesce(sum(${custPosSales.total}),0)`,
      order_count: sql<string>`count(*)`,
    }).from(custPosSales).where(inWin);
    const [ap] = await db.select({ paid: sql<string>`coalesce(sum(${apTransactions.amount}),0)` }).from(apTransactions)
      .where(and(gte(apTransactions.dueDate, start), lt(apTransactions.dueDate, end), sql`${apTransactions.status}::text = 'Paid'`));
    const netRevenue = n(p?.net_revenue);
    const expensesPaid = n(ap?.paid);
    return { month, year, revenue: n(p?.revenue), discounts: n(p?.discounts), tax_collected: n(p?.tax_collected), net_revenue: netRevenue, order_count: n(p?.order_count), expenses_paid: expensesPaid, gross_profit: netRevenue - expensesPaid };
  }

  async ap(status: string, limit: number, offset: number) {
    const db = this.db;
    const rows = await db.select({
      Transaction_ID: apTransactions.txnNo, Creditor_ID: apTransactions.vendorId, Creditor_Name: apTransactions.vendorName, Amount: apTransactions.amount,
      Outstanding_Amount: sql<string>`${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)`,
      Due_Date: apTransactions.dueDate, Status: apTransactions.status, Invoice_No: apTransactions.invoiceNo,
    }).from(apTransactions).where(sql`${apTransactions.status}::text = ${status}`).orderBy(asc(apTransactions.dueDate)).limit(limit).offset(offset);
    const out = rows.map((r: any) => ({ ...r, Amount: n(r.Amount), Outstanding_Amount: n(r.Outstanding_Amount) }));
    return { transactions: out, count: out.length, total_outstanding: round2(out.reduce((a: number, r: any) => a + r.Outstanding_Amount, 0)) };
  }

  async ar(limit: number, offset: number) {
    const db = this.db;
    const rows = await db.select({
      Invoice_No: arInvoices.invoiceNo, Customer_Name: tenants.code, Invoice_Date: arInvoices.invoiceDate, Due_Date: arInvoices.dueDate, Amount: arInvoices.amount,
      Outstanding_Amount: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)`, Status: arInvoices.status,
    }).from(arInvoices).leftJoin(tenants, eq(arInvoices.tenantId, tenants.id)).orderBy(asc(arInvoices.dueDate)).limit(limit).offset(offset);
    const out = rows.map((r: any) => ({ ...r, Amount: n(r.Amount), Outstanding_Amount: n(r.Outstanding_Amount) }));
    return { invoices: out, count: out.length, total_outstanding: round2(out.reduce((a: number, r: any) => a + r.Outstanding_Amount, 0)) };
  }

  async kpi() {
    const db = this.db;
    const today = ymd(); const mStart = monthStart(); const yStart = today.slice(0, 4) + '-01-01';
    const notVoided = ne(custPosSales.status, 'Voided');
    const [mtd] = await db.select({ rev: sql<string>`coalesce(sum(${custPosSales.total}),0)`, ord: sql<string>`count(*)` }).from(custPosSales).where(and(gte(custPosSales.saleDate, mStart), sql`${custPosSales.saleDate} <= ${today}`, notVoided));
    const [ytd] = await db.select({ rev: sql<string>`coalesce(sum(${custPosSales.total}),0)`, ord: sql<string>`count(*)` }).from(custPosSales).where(and(gte(custPosSales.saleDate, yStart), notVoided));
    const [ap] = await db.select({ v: sql<string>`coalesce(sum(${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)),0)` }).from(apTransactions).where(sql`${apTransactions.status}::text <> 'Paid'`);
    const [ar] = await db.select({ v: sql<string>`coalesce(sum(${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)),0)` }).from(arInvoices).where(sql`${arInvoices.status}::text <> 'Paid'`);
    return { mtd_revenue: n(mtd?.rev), mtd_orders: n(mtd?.ord), ytd_revenue: n(ytd?.rev), ytd_orders: n(ytd?.ord), ap_outstanding: n(ap?.v), ar_outstanding: n(ar?.v) };
  }

  // Aging buckets (Current / 1-30 / 31-60 / 61-90 / 90+) by due date vs today.
  private bucketize(rows: { ref: string; party: string | null; due_date: string | null; outstanding: number }[]) {
    const today = ymd();
    const buckets = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
    const detail = rows.filter((r) => r.outstanding > 0.0001).map((r) => {
      const overdue = r.due_date ? Math.round((Date.parse(today) - Date.parse(String(r.due_date))) / 86400000) : 0;
      let bucket: keyof typeof buckets;
      if (overdue <= 0) bucket = 'current';
      else if (overdue <= 30) bucket = 'd1_30';
      else if (overdue <= 60) bucket = 'd31_60';
      else if (overdue <= 90) bucket = 'd61_90';
      else bucket = 'd90_plus';
      buckets[bucket] = round2(buckets[bucket] + r.outstanding);
      return { ...r, days_overdue: Math.max(0, overdue), bucket };
    });
    return { buckets, total: round2(detail.reduce((a, r) => a + r.outstanding, 0)), rows: detail };
  }

  async arAging() {
    const db = this.db;
    const rows = await db.select({
      ref: arInvoices.invoiceNo, party: tenants.code, due_date: arInvoices.dueDate,
      outstanding: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)`,
    }).from(arInvoices).leftJoin(tenants, eq(arInvoices.tenantId, tenants.id)).where(sql`${arInvoices.status}::text <> 'Paid'`);
    const aged = this.bucketize(rows.map((r: any) => ({ ref: r.ref, party: r.party, due_date: r.due_date, outstanding: n(r.outstanding) })));
    // REV-21 — on-account (unapplied) customer cash is a CREDIT against the book: applied receipts already
    // reduced each invoice's outstanding above; the parked remainder is surfaced here so the aged gross and
    // the customer's net position never diverge silently.
    const [ua] = await db.select({ v: sql<string>`coalesce(sum(${arReceipts.unappliedAmount}),0)` }).from(arReceipts);
    const onAccount = round2(n(ua?.v));
    return { ...aged, on_account: onAccount, net_total: round2(aged.total - onAccount) };
  }

  async apAging() {
    const db = this.db;
    const rows = await db.select({
      ref: apTransactions.txnNo, party: apTransactions.vendorName, due_date: apTransactions.dueDate,
      outstanding: sql<string>`${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)`,
    }).from(apTransactions).where(sql`${apTransactions.status}::text <> 'Paid'`);
    return this.bucketize(rows.map((r: any) => ({ ref: r.ref, party: r.party, due_date: r.due_date, outstanding: n(r.outstanding) })));
  }

  // ───────────────────── Statements / printable documents (docs/46 Phase 4a cut 1) ─────────────────────
  // The customer/vendor DOCUMENT surface (AR billing invoice, statements of account, AR receipt vouchers —
  // assemble/HTML/PDF/email + the running-balance statement engine) lives in FinanceDocumentsService
  // (ctor-BODY construction — writeflow builds this facade positionally with 3 args, so sub-services are
  // never DI params). Every public method stays here as a thin delegator: callers + controller unchanged.
  getArInvoiceForPrint(invoiceNo: string, user: JwtUser) { return this.documents.getArInvoiceForPrint(invoiceNo, user); }
  arInvoiceHtml(inv: ArInvoicePrintData) { return this.documents.arInvoiceHtml(inv); }
  renderArInvoicePdf(inv: ArInvoicePrintData) { return this.documents.renderArInvoicePdf(inv); }
  emailArInvoice(invoiceNo: string, toEmail: string | undefined, user: JwtUser) { return this.documents.emailArInvoice(invoiceNo, toEmail, user); }
  getCustomerStatementForPrint(tenantId: number, from: string | undefined, to: string | undefined, currency: string | undefined, user: JwtUser) { return this.documents.getCustomerStatementForPrint(tenantId, from, to, currency, user); }
  getVendorStatementForPrint(vendor: string, from: string | undefined, to: string | undefined, currency: string | undefined, user: JwtUser) { return this.documents.getVendorStatementForPrint(vendor, from, to, currency, user); }
  statementHtml(s: StatementPrintData) { return this.documents.statementHtml(s); }
  renderStatementPdf(s: StatementPrintData) { return this.documents.renderStatementPdf(s); }
  emailStatement(s: StatementPrintData, toEmail: string | undefined) { return this.documents.emailStatement(s, toEmail); }
  listArReceipts(user: JwtUser, limit = 50) { return this.documents.listArReceipts(user, limit); }
  getArReceiptForPrint(receiptNo: string, user: JwtUser) { return this.documents.getArReceiptForPrint(receiptNo, user); }
  arReceiptHtml(r: ArReceiptPrintData) { return this.documents.arReceiptHtml(r); }
  renderArReceiptPdf(r: ArReceiptPrintData) { return this.documents.renderArReceiptPdf(r); }
  emailArReceipt(receiptNo: string, toEmail: string | undefined, user: JwtUser) { return this.documents.emailArReceipt(receiptNo, toEmail, user); }
  customerStatement(tenantId: number, from?: string, to?: string, currency?: string) { return this.documents.customerStatement(tenantId, from, to, currency); }
  vendorStatement(vendor: string, from?: string, to?: string, currency?: string) { return this.documents.vendorStatement(vendor, from, to, currency); }

  // ───────────────────── Petty cash / employee cash advances — EXP-07 (docs/46 Phase 4a cut 2) ─────────
  // Issue/settle/list live in FinanceAdvancesService (ctor-BODY construction, thin delegators here).
  issueAdvance(dto: AdvanceDto, user: JwtUser) { return this.advances.issueAdvance(dto, user); }
  settleAdvance(advanceNo: string, dto: SettleAdvanceDto, user: JwtUser) { return this.advances.settleAdvance(advanceNo, dto, user); }
  listAdvances(tenantId?: number, status?: string) { return this.advances.listAdvances(tenantId, status); }

  // ── AR bad-debt write-off — REV-14 (docs/46 Phase 4a cut 4) ──
  // writeOffAr lives in FinanceArService; the REGISTER (listWriteOffs, below) stays here because it reads
  // the journal tables, which the ledger import-boundary ratchet grandfathers on this file.
  writeOffAr(dto: { tenant_id?: number | null; customer_name?: string; amount: number; reason: string }, user: JwtUser) { return this.arSvc.writeOffAr(dto, user); }

  // The write-off register: every AR-WRITEOFF entry — Draft (pending approval), Posted (approved/effective),
  // or Voided (rejected) — with its amount (the expense debit), so the controller can review bad-debt activity.
  async listWriteOffs(tenantId?: number) {
    const db = this.db;
    // Each write-off has exactly one DEBIT line (the bad-debt expense leg — 5720 or its tenant posting-rule
    // override), so joining on debit > 0 yields one row per write-off regardless of which account it hit.
    const conds: SQL[] = [eq(journalEntries.source, 'AR-WRITEOFF'), sql`${journalLines.debit} > 0`];
    if (tenantId != null) conds.push(eq(journalEntries.tenantId, tenantId));
    const rows = await db.select({
      entryNo: journalEntries.entryNo, status: journalEntries.status, memo: journalEntries.memo,
      createdBy: journalEntries.createdBy, date: journalEntries.entryDate, debit: journalLines.debit,
    }).from(journalEntries).innerJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
      .where(and(...conds)).orderBy(desc(journalEntries.id)).limit(200);
    const list = rows.map((r: any) => ({ entry_no: r.entryNo, status: r.status, memo: r.memo, created_by: r.createdBy, date: r.date, amount: n(r.debit), state: r.status === 'Draft' ? 'pending' : r.status === 'Posted' ? 'approved' : 'rejected' }));
    return {
      write_offs: list, count: list.length,
      pending_count: list.filter((w: any) => w.status === 'Draft').length,
      total_pending: round2(list.filter((w: any) => w.status === 'Draft').reduce((s: number, w: any) => s + w.amount, 0)),
      total_written_off: round2(list.filter((w: any) => w.status === 'Posted').reduce((s: number, w: any) => s + w.amount, 0)),
    };
  }

  // ───────────────────── AR write side (docs/46 Phase 4a cut 4) ─────────────────────
  // Order→invoice sync + cash receipts live in FinanceArService (ctor-BODY construction; the shared
  // vatSplit/vatLegFromCode/resolveOrderProfile stay here as callback ports). Thin delegators.
  syncArInvoices(user: JwtUser) { return this.arSvc.syncArInvoices(user); }
  createReceipt(dto: ReceiptDto, user: JwtUser) { return this.arSvc.createReceipt(dto, user); }


  // ───────────────────── AP bills + disbursement maker-checker — EXP-06/TAX-03 (docs/46 Phase 4a cut 3) ──
  // Bill entry (incl. reverse-charge ภ.พ.36) and the request→approve/reject disbursement flow live in
  // FinanceApService (ctor-BODY construction; the shared vatSplit/vatLegFromCode stay here and are passed
  // as callback ports). Thin delegators keep the public API byte-identical.
  createApTxn(dto: ApTxnDto, user: JwtUser) { return this.apSvc.createApTxn(dto, user); }
  requestApPayment(txnNo: string, amount: number, user: JwtUser, idempotencyKey?: string, wht?: { income_type?: string; rate?: number; tax_code?: string }) { return this.apSvc.requestApPayment(txnNo, amount, user, idempotencyKey, wht); }
  approveApPayment(paymentNo: string, approver: JwtUser, selfApprovalReason?: string | null) { return this.apSvc.approveApPayment(paymentNo, approver, selfApprovalReason); }
  rejectApPayment(paymentNo: string, approver: JwtUser, reason?: string) { return this.apSvc.rejectApPayment(paymentNo, approver, reason); }
  listPendingApPayments(limit: number, offset: number) { return this.apSvc.listPendingApPayments(limit, offset); }

  // Sub-ledger ↔ GL reconciliation: GL control account 1100 must equal open AR outstanding, 2000 = AP.
  async reconcile() {
    const db = this.db;
    const [arSub] = await db.select({ v: sql<string>`coalesce(sum(${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)),0)` }).from(arInvoices).where(sql`${arInvoices.status}::text <> 'Paid'`);
    const [apSub] = await db.select({ v: sql<string>`coalesce(sum(${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)),0)` }).from(apTransactions).where(sql`${apTransactions.status}::text <> 'Paid'`);
    const tb: any = this.ledger ? await this.ledger.trialBalance() : { rows: [] };
    const glBal = (code: string) => { const r = tb.rows.find((x: any) => x.account_code === code); return r ? n(r.balance) : 0; };
    const arGl = glBal('1100'), apGl = -glBal('2000'); // 2000 is a liability → balance negative; flip sign
    return {
      ar: { sub_ledger: n(arSub?.v), gl_control: arGl, reconciled: Math.abs(n(arSub?.v) - arGl) < 0.01 },
      ap: { sub_ledger: n(apSub?.v), gl_control: apGl, reconciled: Math.abs(n(apSub?.v) - apGl) < 0.01 },
    };
  }

  // REC-04 — period-end control-account reconciliation PACK. Ties every major sub-ledger to its GL control
  // account in one view and flags any out-of-balance (a detective control over completeness/accuracy across
  // the whole close): AR↔1100, AP↔2000, Inventory↔1200, Gift cards↔2200, Deferred revenue↔2400. Liability
  // controls (2000/2200/2400) carry a credit balance, so the GL balance is sign-flipped to compare to the
  // (positive) sub-ledger open value. Tenant-scoped via the caller's RLS (HQ/Admin aggregates all tenants).
  async reconcileControls() {
    const db = this.db;
    const tb: any = this.ledger ? await this.ledger.trialBalance() : { rows: [] };
    const glBal = (code: string) => { const r = tb.rows.find((x: any) => x.account_code === code); return r ? n(r.balance) : 0; };
    const [arSub] = await db.select({ v: sql<string>`coalesce(sum(${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)),0)` }).from(arInvoices).where(sql`${arInvoices.status}::text <> 'Paid'`);
    const [apSub] = await db.select({ v: sql<string>`coalesce(sum(${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)),0)` }).from(apTransactions).where(sql`${apTransactions.status}::text <> 'Paid'`);
    const [invSub] = await db.select({ v: sql<string>`coalesce(sum(${invBalances.totalValue}),0)` }).from(invBalances);
    const [gcSub] = await db.select({ v: sql<string>`coalesce(sum(${giftCards.balance}),0)` }).from(giftCards).where(sql`${giftCards.status}::text = 'Active'`);
    const [drSub] = await db.select({ v: sql<string>`coalesce(sum(${revRecLines.amount}),0)` }).from(revRecLines).where(eq(revRecLines.recognized, false));
    const mk = (account: string, label: string, sub: number, gl: number) => { const s = round2(sub), g = round2(gl); return { account, label, sub_ledger: s, gl_control: g, variance: round2(s - g), reconciled: Math.abs(s - g) < 0.01 }; };
    const lines = [
      mk('1100', 'ลูกหนี้การค้า (AR)', n(arSub?.v), glBal('1100')),
      mk('2000', 'เจ้าหนี้การค้า (AP)', n(apSub?.v), -glBal('2000')),
      mk('1200', 'สินค้าคงเหลือ (Inventory)', n(invSub?.v), glBal('1200')),
      mk('2200', 'บัตรของขวัญ / เงินรับล่วงหน้า (Gift cards)', n(gcSub?.v), -glBal('2200')),
      mk('2400', 'รายได้รอตัดบัญชี (Deferred revenue)', n(drSub?.v), -glBal('2400')),
    ];
    return { as_of: ymd(), lines, all_reconciled: lines.every((l) => l.reconciled), exceptions: lines.filter((l) => !l.reconciled).length };
  }

  // GOV-01 — pending-approvals monitor. One worklist of EVERY item awaiting independent (maker-checker)
  // approval across the system, with its age — so the controller can see what is stuck and catch a stale
  // approval (a control breakdown / bottleneck) before close. Read-only; tenant-scoped via the caller's RLS
  // (HQ/Admin sees every tenant; GL-27 rows are platform-global). Since docs/46 Phase 2 each queue LIVES in
  // its owning module (an ApprovalQueueSource provider, discovered at boot by ApprovalQueueRegistrarService):
  // ledger (GL-05/BANK-02, GL-24, GL-27), payroll (PAY-03), assets (FA-08/FA-09), inventory (INV-07),
  // petty-cash (EXP-08), payments (REV-13/REV-16), fx (FX-04), masterdata (MDM-03/MDM-01), budget (BUD-01).
  // Only finance's OWN queues stay inline below: EXP-06 AP disbursements, REV-21 AR cash applications,
  // REV-23 AR/AP netting. A new maker-checker registers a queue from its owning module — never a new inline
  // query here (the check-service-size ratchet enforces it).
  private readonly approvalQueues = new Map<string, ApprovalQueue>();
  registerApprovalQueues(source: ApprovalQueueSource) {
    for (const q of source.approvalQueues()) this.approvalQueues.set(q.source, q);
  }

  async pendingApprovals(opts?: { overdue_days?: number }) {
    const db = this.db;
    const overdueDays = opts?.overdue_days ?? 3;
    const ageDays = approvalAgeDays;
    const items: any[] = [];

    const inline: Record<string, () => Promise<any[]>> = {
      // EXP-06 — AP disbursements awaiting approval.
      ap_payment: async () => {
        const out: any[] = [];
        for (const p of await db.select().from(apPayments).where(eq(apPayments.status, 'PendingApproval')))
          out.push({ type: 'ap_payment', control: 'EXP-06', ref: p.paymentNo, label: `จ่ายเจ้าหนี้ ${p.txnNo}`, amount: n(p.amount), requested_by: p.requestedBy ?? null, requested_at: p.requestedAt ?? null, age_days: ageDays(p.requestedAt) });
        return out;
      },
      // REV-21 — large AR cash applications awaiting approval (grouped per worksheet batch; the cash is
      // banked on-account, no invoice moves until a different user approves).
      ar_cash_application: async () => {
        const out: any[] = [];
        for (const b of await db.select({ batchNo: arReceiptApplications.batchNo, requestedBy: sql<string>`max(${arReceiptApplications.appliedBy})`, total: sql<string>`coalesce(sum(${arReceiptApplications.appliedAmount}),0)`, oldest: sql<string>`min(${arReceiptApplications.appliedAt})` }).from(arReceiptApplications).where(eq(arReceiptApplications.status, 'PendingApproval')).groupBy(arReceiptApplications.batchNo))
          out.push({ type: 'ar_cash_application', control: 'REV-21', ref: b.batchNo, label: `ตัดรับชำระลูกหนี้ ${b.batchNo}`, amount: round2(n(b.total)), requested_by: b.requestedBy ?? null, requested_at: b.oldest ?? null, age_days: ageDays(b.oldest) });
        return out;
      },
      // REV-23 — AR/AP netting contra settlements awaiting approval (no GL/sub-ledger movement until a
      // different user approves; the contra JE + both sub-ledger reliefs post at approval).
      ar_ap_netting: async () => {
        const out: any[] = [];
        for (const st of await db.select().from(nettingSettlements).where(eq(nettingSettlements.status, 'PendingApproval')))
          out.push({ type: 'ar_ap_netting', control: 'REV-23', ref: st.settlementNo, label: `หักกลบลบหนี้ ${st.counterpartyName ?? st.vendorName ?? ''}`.trim(), amount: n(st.netAmount), requested_by: st.proposedBy ?? null, requested_at: st.proposedAt ?? null, age_days: ageDays(st.proposedAt) });
        return out;
      },
    };
    // Canonical aggregation order = the historical inline order, so the worklist's tie order under the
    // stable age sort below is byte-identical to the pre-Phase-2 aggregator. Queues registered by modules
    // but not named here (future maker-checkers) run after the canonical list, in registration order.
    const QUEUE_ORDER = ['gl_drafts', 'ap_payment', 'payroll', 'asset_revaluation', 'asset_disposal', 'inventory_writeoff', 'petty_cash', 'till_variance', 'refund', 'ar_cash_application', 'ar_ap_netting', 'fx_rate', 'posting_rule', 'coa_change', 'masterdata_import', 'masterdata_change', 'budget'];
    const seen = new Set<string>();
    for (const key of QUEUE_ORDER) {
      seen.add(key);
      const q = this.approvalQueues.get(key);
      if (q) items.push(...(await q.pending()));
      else if (inline[key]) items.push(...(await inline[key]!()));
    }
    for (const [key, q] of this.approvalQueues) if (!seen.has(key)) items.push(...(await q.pending()));

    items.sort((a, b) => (b.age_days ?? -1) - (a.age_days ?? -1));
    const byType: Record<string, number> = {};
    for (const it of items) byType[it.type] = (byType[it.type] ?? 0) + 1;
    const ages = items.map((i) => i.age_days).filter((x): x is number => x != null);
    return {
      items, count: items.length, by_type: byType,
      oldest_age_days: ages.length ? Math.max(...ages) : 0,
      overdue_days: overdueDays, overdue: items.filter((i) => (i.age_days ?? 0) >= overdueDays).length,
      total_amount: round2(items.reduce((s, i) => s + (i.amount ?? 0), 0)),
    };
  }
}

function round2(x: number) { return Math.round(x * 100) / 100; }

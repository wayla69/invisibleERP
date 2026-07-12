import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { sql, eq, ne, and, gte, lt, lte, asc, desc, inArray, notInArray, isNull, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, apTransactions, apPayments, arInvoices, arReceipts, arReceiptApplications, orders, orderLines, tenants, employeeAdvances, invBalances, giftCards, revRecLines, journalEntries, journalLines, projects, nettingSettlements } from '../../database/schema';
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

  // ── AR bad-debt write-off (REV-14, maker-checker) ──
  // An uncollectible receivable is written off as bad debt — Dr 5720 Bad Debt Expense / Cr 1100 AR. It posts
  // as a DRAFT via the ledger maker-checker (GL-05): excluded from balances until a DIFFERENT user approves
  // (POST /api/ledger/journal/:entryNo/approve), so one person can't both declare a receivable uncollectible
  // and post the write-off (concealing a misappropriated collection). It appears in the pending-approvals
  // monitor automatically (it is a Draft JE).
  async writeOffAr(dto: { tenant_id?: number | null; customer_name?: string; amount: number; reason: string }, user: JwtUser) {
    if (!this.ledger) throw new BadRequestException({ code: 'LEDGER_UNAVAILABLE', message: 'Ledger not available', messageTh: 'ระบบบัญชีไม่พร้อมใช้งาน' });
    const amount = round2(Number(dto.amount) || 0);
    if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Write-off amount must be positive', messageTh: 'จำนวนหนี้สูญต้องมากกว่า 0' });
    if (!dto.reason || !dto.reason.trim()) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'A write-off reason is required', messageTh: 'ต้องระบุเหตุผลการตัดหนี้สูญ' });
    const tenantId = user.tenantId ?? (dto.tenant_id != null ? Number(dto.tenant_id) : null);
    const who = dto.customer_name?.trim() ? ` — ${dto.customer_name.trim()}` : (dto.tenant_id != null ? ` — ลูกค้า #${dto.tenant_id}` : '');
    // docs/43 PR-2: the expense leg follows the tenant posting-rule (BADDEBT.WRITEOFF.bad_debt_exp);
    // the AR control leg stays pinned (Tier C).
    const wovr = await this.ledger.postingOverrides('BADDEBT.WRITEOFF', tenantId);
    const je: any = await this.ledger.postEntry({
      date: ymd(), source: 'AR-WRITEOFF', sourceRef: `${dto.tenant_id ?? 'NA'}:${new Date().toISOString()}`, tenantId,
      memo: `ตัดหนี้สูญ${who}: ${dto.reason.trim()}`, createdBy: user.username, pendingApproval: true,
      lines: [
        { account_code: wovr.bad_debt_exp ?? postingDefault('BADDEBT.WRITEOFF', 'bad_debt_exp'), debit: amount, memo: `Bad debt write-off${who}` },
        { account_code: '1100', credit: amount, memo: 'AR written off' },
      ],
    });
    return { entry_no: je.entry_no, status: je.status, pending: !!je.pending, amount, reason: dto.reason.trim(), customer_tenant_id: dto.tenant_id ?? null };
  }

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

  // ───────────────────── WRITE (Phase 3) ─────────────────────
  // POST /api/finance/ar/sync — สร้าง INV-{order_no} จาก order ที่ Shipped/Completed ที่ยังไม่มี invoice
  async syncArInvoices(user: JwtUser) {
    const db = this.db;
    const candidates = await db.select({ id: orders.id, orderNo: orders.orderNo, orderDate: orders.orderDate, tenantId: orders.tenantId })
      .from(orders).where(sql`${orders.status}::text in ('Shipped','Completed')`);
    const existing = new Set((await db.select({ no: arInvoices.orderNo }).from(arInvoices)).map((r: any) => r.no));
    const todo = candidates.filter((o: any) => !existing.has(o.orderNo));
    if (!todo.length) return { created: 0 };
    // Batch the per-order line-sum + tenant credit-term lookups (was 2 queries per order → N+1).
    const orderIds = todo.map((o: any) => Number(o.id));
    const sumRows = await db.select({ orderId: orderLines.orderId, a: sql<string>`coalesce(sum(${orderLines.totalPrice}),0)` })
      .from(orderLines).where(inArray(orderLines.orderId, orderIds)).groupBy(orderLines.orderId);
    const sumMap = new Map<number, string>(sumRows.map((r: any) => [Number(r.orderId), r.a]));
    const tenantIds = [...new Set(todo.map((o: any) => o.tenantId).filter((v: any) => v != null))] as number[];
    const termRows = tenantIds.length ? await db.select({ id: tenants.id, ct: tenants.creditTerm }).from(tenants).where(inArray(tenants.id, tenantIds)) : [];
    const termMap = new Map<number, string>(termRows.map((t: any) => [Number(t.id), t.ct]));
    // docs/33 PR6 — output-VAT determination: only tenants that opted into posting_determination get the
    // per-item VAT account (else parity — flat 7/107 → 2100). Prefetch each order's item ids for the lookup.
    const enabledTenants = new Set<number>();
    if (this.determination) for (const t of tenantIds) if (await this.determination.enabled(t)) enabledTenants.add(t);
    const itemsByOrder = new Map<number, string[]>();
    if (enabledTenants.size) {
      const lineRows = await db.select({ orderId: orderLines.orderId, itemId: orderLines.itemId })
        .from(orderLines).where(inArray(orderLines.orderId, orderIds));
      for (const r of lineRows) if (r.itemId) { const a = itemsByOrder.get(Number(r.orderId)) ?? []; a.push(r.itemId); itemsByOrder.set(Number(r.orderId), a); }
    }
    let created = 0;
    for (const o of todo) {
      const amtA = sumMap.get(Number(o.id)) ?? '0';
      let termDays = 30;
      if (o.tenantId != null) termDays = parseInt(String(termMap.get(Number(o.tenantId)) ?? '').replace(/\D/g, ''), 10) || 30;
      const invoiceNo = this.docNo.invoiceFromOrder(o.orderNo);
      await db.insert(arInvoices).values({
        invoiceNo, invoiceDate: o.orderDate, dueDate: addDays(o.orderDate, termDays),
        tenantId: o.tenantId, orderNo: o.orderNo, amount: amtA, paidAmount: '0', status: 'Unpaid', createdBy: 'system',
      }).onConflictDoNothing();
      // GL: recognize receivable + revenue + output VAT (Dr 1100 / Cr <revenue> net / Cr <output-vat> vat).
      // The VAT account/rate AND the revenue account come from the order's uniform item profile when the
      // tenant opted in (docs/33 PR6/PR7); else the flat 7/107 → 2100 and revenue 4000 default. The receivable
      // (grossAmt) is fixed, so VAT is always backed out.
      const grossAmt = n(amtA);
      if (this.ledger && grossAmt > 0 && !(await this.ledger.alreadyPosted('AR', invoiceNo))) {
        let net: number, vat: number, vatAccount = '2100';
        const prof = o.tenantId != null && enabledTenants.has(Number(o.tenantId))
          ? await this.resolveOrderProfile(Number(o.tenantId), itemsByOrder.get(Number(o.id)) ?? []) : { vatCode: null, revenueAccount: null };
        const leg = await this.vatLegFromCode(o.tenantId ?? null, prof.vatCode, grossAmt, 'output', { forceInclusive: true });
        if (leg) { net = leg.net; vat = leg.vat; vatAccount = leg.account; }
        else ({ net, vat } = this.vatSplit(grossAmt));
        const revenueAccount = prof.revenueAccount ?? '4000';
        await this.ledger.postEntry({
          date: o.orderDate ?? undefined, source: 'AR', sourceRef: invoiceNo, tenantId: o.tenantId ?? null,
          memo: `AR invoice ${invoiceNo}`, createdBy: 'system',
          lines: [{ account_code: '1100', debit: grossAmt }, { account_code: revenueAccount, credit: net }, { account_code: vatAccount, credit: vat }],
        });
      }
      created++;
    }
    return { created };
  }

  // POST /api/finance/ar/receipts — RCP- + อัปเดต paid/status
  async createReceipt(dto: ReceiptDto, user: JwtUser) {
    const db = this.db;
    const [inv] = await db.select().from(arInvoices).where(eq(arInvoices.invoiceNo, dto.invoice_no)).limit(1);
    if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found', messageTh: 'ไม่พบใบแจ้งหนี้' });
    // Idempotency: a retried request carrying the same key returns the original receipt instead of
    // minting a new one + re-posting cash + re-incrementing paidAmount (double-collection).
    if (dto.idempotency_key) {
      const [ex] = await db.select().from(arReceipts).where(and(eq(arReceipts.invoiceNo, dto.invoice_no), eq(arReceipts.idempotencyKey, dto.idempotency_key))).limit(1);
      if (ex) { const [cur] = await db.select().from(arInvoices).where(eq(arInvoices.id, inv.id)).limit(1); return { receipt_no: ex.receiptNo, invoice_no: dto.invoice_no, paid_amount: n(cur?.paidAmount), status: cur?.status, idempotent: true }; }
    }
    const receiptNo = await this.docNo.nextDaily('RCP');
    let newPaid = 0; let status = '';
    await db.transaction(async (tx: any) => {
      // Concurrency: lock the invoice row and recompute paidAmount from the LOCKED current value.
      // Without the lock, two concurrent receipts on the same invoice both read the old paidAmount and
      // write absolute totals → the last writer wins and one collection silently vanishes (AR sub-ledger
      // overstated, control account 1100 ≠ cash collected). FOR UPDATE serializes them.
      const [locked] = await tx.select().from(arInvoices).where(eq(arInvoices.id, inv.id)).for('update').limit(1);
      newPaid = n(locked.paidAmount) + n(dto.amount);
      status = newPaid >= n(locked.amount) ? 'Paid' : 'Partial';
      await tx.insert(arReceipts).values({
        receiptNo, receiptDate: ymd(), tenantId: inv.tenantId, invoiceNo: dto.invoice_no, amount: String(n(dto.amount)),
        method: dto.method ?? 'Transfer', refNo: dto.ref_no ?? null, remarks: dto.remarks ?? null, idempotencyKey: dto.idempotency_key ?? null, createdBy: user.username,
      });
      await tx.update(arInvoices).set({ paidAmount: String(newPaid), status }).where(eq(arInvoices.id, inv.id));
    });
    // GL: collect cash against the receivable (Dr 1000 Cash / Cr 1100 AR). Guarded so a same-receipt re-run posts once.
    if (this.ledger && n(dto.amount) > 0 && !(await this.ledger.alreadyPosted('RCP', receiptNo, inv.tenantId ?? null))) {
      await this.ledger.postEntry({
        date: ymd(), source: 'RCP', sourceRef: receiptNo, tenantId: inv.tenantId ?? null,
        memo: `Receipt ${receiptNo} for ${dto.invoice_no}`, createdBy: user.username,
        lines: [{ account_code: '1000', debit: n(dto.amount) }, { account_code: '1100', credit: n(dto.amount) }],
      });
    }
    await this.statusLog.log('INV', dto.invoice_no, inv.status ?? '', status, user.username, `Receipt ${receiptNo}`);
    return { receipt_no: receiptNo, invoice_no: dto.invoice_no, paid_amount: newPaid, status };
  }

  // POST /api/finance/ap/transactions — AP-
  async createApTxn(dto: ApTxnDto, user: JwtUser) {
    const db = this.db;
    // input VAT is per shop (ภ.พ.30) → tenant-scoped. An internal caller (e.g. ESS reimbursement, EAM
    // maintenance) may pin the AP to the source document's tenant via dto.tenant_id.
    const tenantId = dto.tenant_id ?? user.tenantId ?? null;
    // Maker-checker (EXP-06): a bill cannot be booked pre-paid in one call — that would disburse cash with no
    // second-person approval. Disbursement must go through requestApPayment → approveApPayment (always Unpaid here).
    if (n(dto.paid_amount) > 0) {
      throw new BadRequestException({ code: 'AP_PREPAID_BLOCKED', message: 'A bill cannot be created pre-paid; record the payment via the approval flow', messageTh: 'ห้ามสร้างบิลพร้อมจ่าย ต้องบันทึกการจ่ายผ่านการอนุมัติ' });
    }
    // Idempotency: a retried request with the same key returns the original bill (no duplicate payable/expense).
    if (dto.idempotency_key) {
      const tenantPred = tenantId != null ? eq(apTransactions.tenantId, tenantId) : isNull(apTransactions.tenantId);
      const [ex] = await db.select().from(apTransactions).where(and(tenantPred, eq(apTransactions.idempotencyKey, dto.idempotency_key))).limit(1);
      if (ex) return { txn_no: ex.txnNo, status: ex.status, idempotent: true };
    }
    const txnNo = await this.docNo.nextDaily('AP');
    // input VAT — a configured tax_code (docs/33 PR6) drives the rate + input-VAT GL account; else the flat
    // 7/107 default (exempt/zero-rated/non-VAT bills carry NO input VAT, else ภ.พ.30 overstates the credit).
    const treatment = dto.vat_treatment ?? 'standard';
    // ภ.พ.36 (ม.83/6) — imported services from an offshore/non-VAT-registered supplier: the supplier charges NO
    // Thai VAT, so the payer BOOKS THE BILL AT NET (gross = net, no vendor input-VAT leg) and SELF-ASSESSES 7%
    // output VAT to remit via ภ.พ.36, taking the mirror amount as a recoverable input-VAT credit. The
    // self-assessment posts Dr 1300 Input VAT / Cr 2120 PP36 VAT Payable (a wash on the P&L; the 2120 liability
    // is the remittance obligation the ภ.พ.36 report reads, kept out of the ภ.พ.30/2100 set).
    const reverseCharge = treatment === 'reverse_charge';
    const leg = reverseCharge ? null : await this.vatLegFromCode(tenantId, dto.tax_code, n(dto.amount), 'input');
    const fallback = treatment === 'standard' ? this.vatSplit(n(dto.amount)) : { net: n(dto.amount), vat: 0 };
    const net = leg ? leg.net : fallback.net;
    const vat = leg ? leg.vat : fallback.vat; // vendor input VAT on the bill (0 for reverse-charge — none exists)
    const apGross = leg ? leg.gross : n(dto.amount);
    const vatAccount = leg?.account ?? '2100';
    const selfVat = reverseCharge ? round2(net * 0.07) : 0; // ภ.พ.36 self-assessed output VAT (= recoverable input VAT)
    const paid = n(dto.paid_amount);
    const status = paid >= apGross ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid';
    await db.insert(apTransactions).values({
      txnNo, tenantId, vendorId: dto.vendor_id ?? null, vendorName: dto.vendor_name ?? null, txnType: dto.txn_type ?? 'Invoice',
      invoiceNo: dto.invoice_no ?? null, invoiceDate: dto.invoice_date ?? null, dueDate: dto.due_date ?? null,
      amount: String(apGross), vatAmount: fx(vat, 2), reverseCharge, paidAmount: String(paid), status, remarks: dto.remarks ?? null, idempotencyKey: dto.idempotency_key ?? null, createdBy: user.username,
    });
    // GL: record expense + input VAT + payable (Dr 5100/1200/override net / Dr <input-vat> vat / Cr 2000 gross). Zero VAT leg auto-drops.
    // For reverse-charge, append the ภ.พ.36 self-assessment pair (Dr 1300 / Cr 2120) — the whole entry stays balanced.
    if (this.ledger && apGross > 0) {
      const expenseAccount = dto.expense_account ?? ((dto.txn_type === 'Goods' || dto.txn_type === 'Inventory') ? '1200' : '5100');
      const lines = [{ account_code: expenseAccount, debit: net }, { account_code: vatAccount, debit: vat }, { account_code: '2000', credit: apGross }];
      if (selfVat > 0) {
        const rcOvr = await this.ledger.postingOverrides('RCVAT.SELF', tenantId);
        lines.push({ account_code: rcOvr.input_vat ?? postingDefault('RCVAT.SELF', 'input_vat'), debit: selfVat }, { account_code: rcOvr.pp36_payable ?? postingDefault('RCVAT.SELF', 'pp36_payable'), credit: selfVat });
      }
      await this.ledger.postEntry({
        date: dto.invoice_date ?? ymd(), source: 'AP', sourceRef: txnNo, tenantId,
        memo: `AP bill ${txnNo}${dto.vendor_name ? ' ' + dto.vendor_name : ''}${reverseCharge ? ' (ภ.พ.36 reverse-charge)' : ''}`, createdBy: user.username,
        lines,
      });
    }
    await this.statusLog.log('AP', txnNo, '', status, user.username);
    return { txn_no: txnNo, status };
  }

  // ───────────────────── AP disbursement maker-checker (AP-PAY) ─────────────────────
  // Step 1 (MAKER, `creditors`) — REQUEST a vendor payment. No cash moves and NO GL posts here: the bill's
  // paid_amount is untouched and a PendingApproval row is recorded. PATCH /api/finance/ap/transactions/{no}/pay
  async requestApPayment(txnNo: string, amount: number, user: JwtUser, idempotencyKey?: string, wht?: { income_type?: string; rate?: number; tax_code?: string }) {
    const db = this.db;
    const [t] = await db.select().from(apTransactions).where(eq(apTransactions.txnNo, txnNo)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP txn not found', messageTh: 'ไม่พบรายการ AP' });
    // Phase 16 — 3-way match gate: a PO-based invoice must pass match (or be overridden) before payment.
    if (this.matchSvc) await this.matchSvc.assertPayable(txnNo);
    const apTenant = t.tenantId ?? user.tenantId ?? null;
    // Idempotency: a retried request with the same key returns the original pending payment (no duplicate).
    if (idempotencyKey) {
      const tenantPred = apTenant != null ? eq(apPayments.tenantId, apTenant) : isNull(apPayments.tenantId);
      const [ex] = await db.select().from(apPayments).where(and(tenantPred, eq(apPayments.idempotencyKey, idempotencyKey))).limit(1);
      if (ex) return { payment_no: ex.paymentNo, txn_no: txnNo, amount: n(ex.amount), status: ex.status, idempotent: true };
    }
    // Over-request guard: a new request cannot exceed outstanding minus payments already awaiting approval
    // (so two pending requests can't be approved into an overpayment).
    const [agg] = await db.select({ pend: sql<string>`coalesce(sum(${apPayments.amount}),0)` }).from(apPayments)
      .where(and(eq(apPayments.txnNo, txnNo), eq(apPayments.status, 'PendingApproval')));
    const outstanding = round2(n(t.amount) - n(t.paidAmount) - n(agg?.pend));
    if (n(amount) > outstanding + 0.001) {
      throw new BadRequestException({ code: 'AP_OVERPAY', message: `Amount ${amount} exceeds payable balance ${outstanding}`, messageTh: 'ยอดจ่ายเกินยอดคงค้าง (รวมรายการที่รออนุมัติ)' });
    }
    // TAX-03 — optional withholding tax (ภ.ง.ด.3/53). The rate is captured here; the amount is computed on the
    // pre-VAT base and posted to GL 2361 at approval (the actual cash/GL event). Bounded to a sane 0–30%.
    // docs/33 PR7: a WHT tax_code defaults the income type + rate when the caller omits them (makes the WHT
    // side of tax_codes live — ค่าจ้างทำของ/ค่าบริการ). An explicit income_type/rate still wins.
    let whtRate: number | null = wht?.rate ?? null;
    let whtIncome: string | null = wht?.income_type ?? null;
    if (wht?.tax_code && this.determination) {
      const tc = await this.determination.resolveTaxCode(apTenant, wht.tax_code);
      if (!tc || tc.kind !== 'wht') throw new BadRequestException({ code: 'INVALID_WHT_TAX_CODE', message: `Tax code '${wht.tax_code}' is not an active WHT code`, messageTh: `รหัสภาษี '${wht.tax_code}' ไม่ใช่รหัสหัก ณ ที่จ่ายที่ใช้งานอยู่` });
      whtIncome = whtIncome ?? tc.whtIncomeType ?? null;
      whtRate = whtRate ?? n(tc.rate);
    }
    if (whtRate != null && !(whtRate > 0 && whtRate <= 0.30)) {
      throw new BadRequestException({ code: 'INVALID_WHT_RATE', message: 'WHT rate must be between 0 and 0.30', messageTh: 'อัตราภาษีหัก ณ ที่จ่ายต้องอยู่ระหว่าง 0 ถึง 0.30' });
    }
    const paymentNo = await this.docNo.nextDaily('APP');
    await db.insert(apPayments).values({
      paymentNo, txnNo, tenantId: apTenant, amount: String(n(amount)), status: 'PendingApproval',
      requestedBy: user.username, glRef: `${txnNo}:p:${paymentNo}`, idempotencyKey: idempotencyKey ?? null,
      whtIncomeType: whtRate != null ? whtIncome : null, whtRate: whtRate != null ? String(whtRate) : null,
    });
    await this.statusLog.log('APP', paymentNo, '', 'PendingApproval', user.username, `Payment request ${n(amount)} for ${txnNo}${whtRate != null ? ` (WHT ${whtRate * 100}%)` : ''}`);
    return { payment_no: paymentNo, txn_no: txnNo, amount: n(amount), status: 'PendingApproval', wht_rate: whtRate };
  }

  // Step 2 (CHECKER, approval authority) — APPROVE a pending payment. The approver MUST differ from the
  // requester (segregation of duties) regardless of permissions held — even an Admin cannot approve their
  // own request. Only here does paid_amount move (under a row lock) and the cash-disbursement GL post.
  async approveApPayment(paymentNo: string, approver: JwtUser) {
    const db = this.db;
    const [p] = await db.select().from(apPayments).where(eq(apPayments.paymentNo, paymentNo)).limit(1);
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP payment not found', messageTh: 'ไม่พบรายการจ่าย' });
    if (p.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Payment ${paymentNo} is ${p.status}, not pending approval`, messageTh: 'รายการนี้ไม่ได้รออนุมัติ' });
    if (p.requestedBy && p.requestedBy === approver.username) {
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a payment you requested', messageTh: 'ผู้ขอจ่ายอนุมัติรายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const apTenant = p.tenantId ?? approver.tenantId ?? null;
    let newPaid = 0; let billStatus = '';
    let billGross = 0, billVat = 0;
    await db.transaction(async (tx: any) => {
      // Lock the bill row and recompute from the LOCKED paid total → no lost update vs a concurrent approval.
      const [t] = await tx.select().from(apTransactions).where(eq(apTransactions.txnNo, p.txnNo)).for('update').limit(1);
      if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP txn not found', messageTh: 'ไม่พบรายการ AP' });
      billGross = n(t.amount); billVat = n(t.vatAmount);
      newPaid = round2(n(t.paidAmount) + n(p.amount));
      billStatus = newPaid >= n(t.amount) ? 'Paid' : newPaid > 0 ? 'Partial' : 'Unpaid';
      await tx.update(apTransactions).set({ paidAmount: String(newPaid), status: billStatus }).where(eq(apTransactions.id, t.id));
      await tx.update(apPayments).set({ status: 'Approved', approvedBy: approver.username, approvedAt: new Date() }).where(eq(apPayments.id, p.id));
    });
    // TAX-03 — withholding tax on this payment, computed on the PRE-VAT base (Thai WHT is on the fee, not VAT).
    // Prorate the base by the bill's net/gross ratio so partial payments withhold proportionally.
    const whtRate = n(p.whtRate);
    let whtAmount = 0;
    if (whtRate > 0) {
      const baseRatio = billGross > 0 ? (billGross - billVat) / billGross : 1;
      whtAmount = round2(round2(n(p.amount) * baseRatio) * whtRate);
    }
    // GL: clear the full payable (Dr 2000), hold the WHT (Cr 2361), pay the vendor net (Cr 1000). With no WHT
    // this is the original Dr 2000 / Cr 1000. The per-request glRef is stable + unique → idempotent post.
    if (this.ledger && n(p.amount) > 0 && !(await this.ledger.alreadyPosted('PAY-AP', p.glRef!, apTenant))) {
      const lines: any[] = [{ account_code: '2000', debit: n(p.amount) }];
      if (whtAmount > 0) {
        const whtOvr = await this.ledger.postingOverrides('APPAY.WHT', apTenant);
        lines.push({ account_code: whtOvr.wht_payable ?? postingDefault('APPAY.WHT', 'wht_payable'), credit: whtAmount });
      }
      lines.push({ account_code: '1000', credit: round2(n(p.amount) - whtAmount) });
      await this.ledger.postEntry({
        date: ymd(), source: 'PAY-AP', sourceRef: p.glRef ?? undefined, tenantId: apTenant,
        memo: `AP payment ${p.txnNo} (${paymentNo})${whtAmount > 0 ? ` — WHT ฿${whtAmount}` : ''}`, createdBy: approver.username,
        lines,
      });
      if (whtAmount > 0) await db.update(apPayments).set({ whtAmount: String(whtAmount) }).where(eq(apPayments.id, p.id));
    }
    await this.statusLog.log('APP', paymentNo, 'PendingApproval', 'Approved', approver.username);
    return { payment_no: paymentNo, txn_no: p.txnNo, status: 'Approved', approved_by: approver.username, requested_by: p.requestedBy, paid_amount: newPaid, bill_status: billStatus, wht_amount: whtAmount, net_paid: round2(n(p.amount) - whtAmount) };
  }

  // Step 2 (alt) — REJECT a pending payment (no cash/GL effect; recorded for the audit trail).
  async rejectApPayment(paymentNo: string, approver: JwtUser, reason?: string) {
    const db = this.db;
    const [p] = await db.select().from(apPayments).where(eq(apPayments.paymentNo, paymentNo)).limit(1);
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP payment not found', messageTh: 'ไม่พบรายการจ่าย' });
    if (p.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Payment ${paymentNo} is ${p.status}, not pending approval`, messageTh: 'รายการนี้ไม่ได้รออนุมัติ' });
    await db.update(apPayments).set({ status: 'Rejected', approvedBy: approver.username, approvedAt: new Date(), rejectReason: reason ?? null }).where(eq(apPayments.id, p.id));
    await this.statusLog.log('APP', paymentNo, 'PendingApproval', 'Rejected', approver.username, reason);
    return { payment_no: paymentNo, txn_no: p.txnNo, status: 'Rejected', rejected_by: approver.username };
  }

  // Checker queue — AP payments awaiting approval (joined to the bill for context).
  async listPendingApPayments(limit: number, offset: number) {
    const db = this.db;
    const rows = await db.select({
      payment_no: apPayments.paymentNo, txn_no: apPayments.txnNo, amount: apPayments.amount,
      requested_by: apPayments.requestedBy, requested_at: apPayments.requestedAt,
      vendor_name: apTransactions.vendorName, bill_amount: apTransactions.amount, paid_amount: apTransactions.paidAmount,
    }).from(apPayments).leftJoin(apTransactions, eq(apPayments.txnNo, apTransactions.txnNo))
      .where(eq(apPayments.status, 'PendingApproval')).orderBy(asc(apPayments.requestedAt)).limit(limit).offset(offset);
    const out = rows.map((r: any) => ({ ...r, amount: n(r.amount), bill_amount: n(r.bill_amount), paid_amount: n(r.paid_amount) }));
    return { payments: out, count: out.length };
  }

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
function addDays(dateStr: string | null, days: number): string {
  const d = dateStr ? new Date(dateStr) : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

import { Inject, Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { sql, eq, ne, and, gte, lt, lte, asc, desc, inArray, notInArray, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, apTransactions, apPayments, arInvoices, arReceipts, orders, orderLines, tenants, employeeAdvances, invBalances, giftCards, revRecLines, journalEntries, journalLines, payruns, assetRevaluations, fixedAssets, invWriteoffRequests, expenseRequests, tillSessions } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { LedgerService } from '../ledger/ledger.service';
import { TaxService } from '../tax/tax.service';
import { ThreeWayMatchService } from '../match/three-way-match.service';
import { ymd, monthStart, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface ReceiptDto { invoice_no: string; amount: number; method?: string; ref_no?: string; remarks?: string; idempotency_key?: string }
export interface ApTxnDto { vendor_id?: number; vendor_name?: string; txn_type?: string; invoice_no?: string; invoice_date?: string; due_date?: string; amount: number; paid_amount?: number; remarks?: string; vat_treatment?: 'standard' | 'exempt' | 'zero'; idempotency_key?: string; expense_account?: string; tenant_id?: number | null }
export interface AdvanceDto { payee: string; amount: number; purpose?: string; expense_account?: string; tenant_id?: number | null }
export interface SettleAdvanceDto { settled_expense: number; returned_cash?: number; expense_account?: string }

@Injectable()
export class FinanceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    // optional + last so the writeflow harness (which constructs FinanceService by hand with 3 args)
    // still compiles; when absent, GL posting is skipped (sub-ledger behaviour unchanged).
    @Optional() private readonly ledger?: LedgerService,
    @Optional() private readonly tax?: TaxService,
    @Optional() private readonly matchSvc?: ThreeWayMatchService, // Phase 16 — gates AP pay on 3-way match
  ) {}

  // VAT back-out (7/107) — prefer TaxService.calcInclusive when injected
  private vatSplit(gross: number): { net: number; vat: number } {
    if (this.tax) { const r = this.tax.calcInclusive({ gross }); return { net: r.net, vat: r.tax }; }
    const vat = Math.round((gross * 7 / 107) * 100) / 100;
    return { net: Math.round((gross - vat) * 100) / 100, vat };
  }

  // ───────────────────── READ (Phase 2) ─────────────────────
  async pl(month: number, year: number) {
    const db = this.db as any;
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
    const db = this.db as any;
    const rows = await db.select({
      Transaction_ID: apTransactions.txnNo, Creditor_ID: apTransactions.vendorId, Creditor_Name: apTransactions.vendorName, Amount: apTransactions.amount,
      Outstanding_Amount: sql<string>`${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)`,
      Due_Date: apTransactions.dueDate, Status: apTransactions.status, Invoice_No: apTransactions.invoiceNo,
    }).from(apTransactions).where(sql`${apTransactions.status}::text = ${status}`).orderBy(asc(apTransactions.dueDate)).limit(limit).offset(offset);
    const out = rows.map((r: any) => ({ ...r, Amount: n(r.Amount), Outstanding_Amount: n(r.Outstanding_Amount) }));
    return { transactions: out, count: out.length, total_outstanding: round2(out.reduce((a: number, r: any) => a + r.Outstanding_Amount, 0)) };
  }

  async ar(limit: number, offset: number) {
    const db = this.db as any;
    const rows = await db.select({
      Invoice_No: arInvoices.invoiceNo, Customer_Name: tenants.code, Invoice_Date: arInvoices.invoiceDate, Due_Date: arInvoices.dueDate, Amount: arInvoices.amount,
      Outstanding_Amount: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)`, Status: arInvoices.status,
    }).from(arInvoices).leftJoin(tenants, eq(arInvoices.tenantId, tenants.id)).orderBy(asc(arInvoices.dueDate)).limit(limit).offset(offset);
    const out = rows.map((r: any) => ({ ...r, Amount: n(r.Amount), Outstanding_Amount: n(r.Outstanding_Amount) }));
    return { invoices: out, count: out.length, total_outstanding: round2(out.reduce((a: number, r: any) => a + r.Outstanding_Amount, 0)) };
  }

  async kpi() {
    const db = this.db as any;
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
    const db = this.db as any;
    const rows = await db.select({
      ref: arInvoices.invoiceNo, party: tenants.code, due_date: arInvoices.dueDate,
      outstanding: sql<string>`${arInvoices.amount} - coalesce(${arInvoices.paidAmount},0)`,
    }).from(arInvoices).leftJoin(tenants, eq(arInvoices.tenantId, tenants.id)).where(sql`${arInvoices.status}::text <> 'Paid'`);
    return this.bucketize(rows.map((r: any) => ({ ref: r.ref, party: r.party, due_date: r.due_date, outstanding: n(r.outstanding) })));
  }

  async apAging() {
    const db = this.db as any;
    const rows = await db.select({
      ref: apTransactions.txnNo, party: apTransactions.vendorName, due_date: apTransactions.dueDate,
      outstanding: sql<string>`${apTransactions.amount} - coalesce(${apTransactions.paidAmount},0)`,
    }).from(apTransactions).where(sql`${apTransactions.status}::text <> 'Paid'`);
    return this.bucketize(rows.map((r: any) => ({ ref: r.ref, party: r.party, due_date: r.due_date, outstanding: n(r.outstanding) })));
  }

  // ───────────────────── Statements of account (customer / vendor) ─────────────────────
  // A running-balance statement over [from,to]: opening balance struck before the window, then every
  // charge (invoice/bill) and payment (receipt/disbursement) in date order, with a closing balance.
  // Multi-currency: each document keeps its own currency + booked fx rate. With no `currency` filter the
  // statement reports in base THB (each doc converted at its fx rate); with `?currency=USD` it reports only
  // that currency's documents in their own units. A receipt/payment inherits the currency of the invoice/
  // bill it settles.
  async customerStatement(tenantId: number, from?: string, to?: string, currency?: string) {
    const db = this.db as any;
    const lo = from ?? '0001-01-01';
    const hi = to ?? '9999-12-31';
    const invs = await db.select({ date: arInvoices.invoiceDate, ref: arInvoices.invoiceNo, amt: arInvoices.amount, cur: arInvoices.currency, fx: arInvoices.fxRate }).from(arInvoices).where(eq(arInvoices.tenantId, tenantId));
    const invByNo = new Map<string, { cur: string; fx: number }>(invs.map((i: any) => [i.ref, { cur: i.cur ?? 'THB', fx: n(i.fx) || 1 }]));
    const rcps = await db.select({ date: arReceipts.receiptDate, ref: arReceipts.receiptNo, amt: arReceipts.amount, inv: arReceipts.invoiceNo }).from(arReceipts).where(eq(arReceipts.tenantId, tenantId));
    const events = [
      ...invs.map((i: any) => ({ date: i.date, type: 'invoice', ref: i.ref, cur: i.cur ?? 'THB', fx: n(i.fx) || 1, charge: n(i.amt), payment: 0 })),
      ...rcps.map((rc: any) => { const k = invByNo.get(rc.inv) ?? { cur: 'THB', fx: 1 }; return { date: rc.date, type: 'receipt', ref: rc.ref, cur: k.cur, fx: k.fx, charge: 0, payment: n(rc.amt) }; }),
    ];
    return this.buildStatement('customer', String(tenantId), events, lo, hi, currency);
  }

  async vendorStatement(vendor: string, from?: string, to?: string, currency?: string) {
    const db = this.db as any;
    const lo = from ?? '0001-01-01';
    const hi = to ?? '9999-12-31';
    const bills = await db.select({ date: apTransactions.invoiceDate, ref: apTransactions.txnNo, amt: apTransactions.amount, cur: apTransactions.currency, fx: apTransactions.fxRate }).from(apTransactions).where(eq(apTransactions.vendorName, vendor));
    // Approved disbursements inherit the bill's currency + booked rate (join on txn_no).
    const pays = await db.select({ date: sql<string>`${apPayments.approvedAt}::date`, ref: apPayments.paymentNo, amt: apPayments.amount, cur: apTransactions.currency, fx: apTransactions.fxRate }).from(apPayments).innerJoin(apTransactions, eq(apPayments.txnNo, apTransactions.txnNo)).where(and(eq(apTransactions.vendorName, vendor), eq(apPayments.status, 'Approved')));
    const events = [
      ...bills.map((b: any) => ({ date: b.date, type: 'bill', ref: b.ref, cur: b.cur ?? 'THB', fx: n(b.fx) || 1, charge: n(b.amt), payment: 0 })),
      ...pays.map((p: any) => ({ date: p.date, type: 'payment', ref: p.ref, cur: p.cur ?? 'THB', fx: n(p.fx) || 1, charge: 0, payment: n(p.amt) })),
    ];
    return this.buildStatement('vendor', vendor, events, lo, hi, currency);
  }

  private buildStatement(party_type: string, party: string, raw: any[], from: string, to: string, currency?: string) {
    const reporting = currency || 'THB';
    // amount in the reporting currency: filtered → the document's own units; unfiltered → base THB at fx.
    const evs = raw
      .filter((e) => (currency ? e.cur === currency : true))
      .map((e) => ({
        date: e.date, type: e.type, ref: e.ref, doc_currency: e.cur, fx_rate: e.fx,
        doc_charge: round2(e.charge), doc_payment: round2(e.payment),
        charge: round2(currency ? e.charge : e.charge * e.fx),
        payment: round2(currency ? e.payment : e.payment * e.fx),
      }));
    const opening = round2(evs.filter((e) => String(e.date ?? '') < from).reduce((a, e) => a + e.charge - e.payment, 0));
    const win = evs.filter((e) => { const d = String(e.date ?? ''); return d >= from && d <= to; });
    win.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || String(a.ref).localeCompare(String(b.ref)));
    let bal = opening;
    const lines = win.map((e) => { bal = round2(bal + e.charge - e.payment); return { ...e, balance: bal }; });
    const charges = round2(win.reduce((a, e) => a + e.charge, 0));
    const payments = round2(win.reduce((a, e) => a + e.payment, 0));
    return { party_type, party, reporting_currency: reporting, from, to, opening_balance: opening, total_charges: charges, total_payments: payments, closing_balance: round2(opening + charges - payments), lines };
  }

  // ───────────────────── Petty cash / employee cash advances (EXP-07) ─────────────────────
  // Issue an advance: cash out to the employee, Dr 1180 Employee Advances / Cr 1000 Cash. The 1180 balance
  // is the outstanding float; it clears on settlement.
  async issueAdvance(dto: AdvanceDto, user: JwtUser) {
    const amount = round2(dto.amount);
    if (!(amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินต้องมากกว่าศูนย์' });
    const db = this.db as any;
    const tenantId = dto.tenant_id ?? user.tenantId ?? null;
    const advanceNo = await this.docNo.nextDaily('ADV');
    const today = ymd();
    await db.insert(employeeAdvances).values({
      advanceNo, tenantId, payee: dto.payee, purpose: dto.purpose ?? null, amount: String(amount), status: 'open',
      expenseAccount: dto.expense_account ?? '5100', issuedBy: user.username, issuedDate: today,
    });
    if (this.ledger) await this.ledger.postEntry({ date: today, source: 'ADV', sourceRef: advanceNo, tenantId, memo: `Cash advance ${advanceNo} — ${dto.payee}`, createdBy: user.username, lines: [{ account_code: '1180', debit: amount }, { account_code: '1000', credit: amount }] });
    return { advance_no: advanceNo, payee: dto.payee, amount, status: 'open' };
  }

  // Settle an advance: the employee's actual spend posts to the expense account, any unused cash is returned.
  // settled_expense + returned_cash must equal the advance — Dr expense + Dr 1000 / Cr 1180 (clears the float).
  async settleAdvance(advanceNo: string, dto: SettleAdvanceDto, user: JwtUser) {
    const db = this.db as any;
    const [a] = await db.select().from(employeeAdvances).where(eq(employeeAdvances.advanceNo, advanceNo)).limit(1);
    if (!a) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Advance not found', messageTh: 'ไม่พบเงินทดรองจ่าย' });
    if (a.status === 'settled') throw new BadRequestException({ code: 'ALREADY_SETTLED', message: 'Advance already settled', messageTh: 'เงินทดรองจ่ายนี้เคลียร์แล้ว' });
    const spent = round2(dto.settled_expense);
    const returned = round2(dto.returned_cash ?? 0);
    if (round2(spent + returned) !== round2(n(a.amount))) throw new BadRequestException({ code: 'SETTLE_MISMATCH', message: `settled_expense + returned_cash (${round2(spent + returned)}) must equal the advance (${n(a.amount)})`, messageTh: 'ยอดใช้จ่ายรวมเงินคืนต้องเท่ากับเงินทดรองจ่าย' });
    const expAcct = dto.expense_account ?? a.expenseAccount ?? '5100';
    const lines: any[] = [];
    if (spent > 0) lines.push({ account_code: expAcct, debit: spent });
    if (returned > 0) lines.push({ account_code: '1000', debit: returned });
    lines.push({ account_code: '1180', credit: round2(n(a.amount)) });
    if (this.ledger) await this.ledger.postEntry({ date: ymd(), source: 'ADV-STL', sourceRef: advanceNo, tenantId: a.tenantId ?? null, memo: `Settle advance ${advanceNo}`, createdBy: user.username, lines });
    await db.update(employeeAdvances).set({ status: 'settled', settledExpense: String(spent), returnedCash: String(returned), settledBy: user.username, settledDate: ymd() }).where(eq(employeeAdvances.id, a.id));
    return { advance_no: advanceNo, status: 'settled', settled_expense: spent, returned_cash: returned };
  }

  async listAdvances(tenantId?: number, status?: string) {
    const db = this.db as any;
    const conds = [] as any[];
    if (tenantId != null) conds.push(eq(employeeAdvances.tenantId, tenantId));
    if (status) conds.push(eq(employeeAdvances.status, status));
    const rows = await db.select().from(employeeAdvances).where(conds.length ? and(...conds) : undefined).orderBy(desc(employeeAdvances.id));
    return { advances: rows.map((r: any) => ({ advance_no: r.advanceNo, payee: r.payee, purpose: r.purpose, amount: n(r.amount), status: r.status, settled_expense: n(r.settledExpense), returned_cash: n(r.returnedCash), issued_by: r.issuedBy, issued_date: r.issuedDate, settled_date: r.settledDate })), count: rows.length, outstanding: round2(rows.filter((r: any) => r.status === 'open').reduce((s: number, r: any) => s + n(r.amount), 0)) };
  }

  // ───────────────────── WRITE (Phase 3) ─────────────────────
  // POST /api/finance/ar/sync — สร้าง INV-{order_no} จาก order ที่ Shipped/Completed ที่ยังไม่มี invoice
  async syncArInvoices(user: JwtUser) {
    const db = this.db as any;
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
      // GL: recognize receivable + revenue + output VAT (Dr 1100 / Cr 4000 net / Cr 2100 vat)
      const grossAmt = n(amtA);
      if (this.ledger && grossAmt > 0 && !(await this.ledger.alreadyPosted('AR', invoiceNo))) {
        const { net, vat } = this.vatSplit(grossAmt);
        await this.ledger.postEntry({
          date: o.orderDate ?? undefined, source: 'AR', sourceRef: invoiceNo, tenantId: o.tenantId ?? null,
          memo: `AR invoice ${invoiceNo}`, createdBy: 'system',
          lines: [{ account_code: '1100', debit: grossAmt }, { account_code: '4000', credit: net }, { account_code: '2100', credit: vat }],
        });
      }
      created++;
    }
    return { created };
  }

  // POST /api/finance/ar/receipts — RCP- + อัปเดต paid/status
  async createReceipt(dto: ReceiptDto, user: JwtUser) {
    const db = this.db as any;
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
    const db = this.db as any;
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
    const paid = n(dto.paid_amount);
    const status = paid >= n(dto.amount) ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid';
    const apGross = n(dto.amount);
    // input VAT — exempt/zero-rated/non-VAT bills carry NO input VAT (else ภ.พ.30 overstates the credit).
    const treatment = dto.vat_treatment ?? 'standard';
    const { net, vat } = treatment === 'standard' ? this.vatSplit(apGross) : { net: apGross, vat: 0 };
    await db.insert(apTransactions).values({
      txnNo, tenantId, vendorId: dto.vendor_id ?? null, vendorName: dto.vendor_name ?? null, txnType: dto.txn_type ?? 'Invoice',
      invoiceNo: dto.invoice_no ?? null, invoiceDate: dto.invoice_date ?? null, dueDate: dto.due_date ?? null,
      amount: String(apGross), vatAmount: fx(vat, 2), paidAmount: String(paid), status, remarks: dto.remarks ?? null, idempotencyKey: dto.idempotency_key ?? null, createdBy: user.username,
    });
    // GL: record expense + input VAT + payable (Dr 5100/1200/override net / Dr 2100 vat / Cr 2000 gross). Zero VAT leg auto-drops.
    if (this.ledger && apGross > 0) {
      const expenseAccount = dto.expense_account ?? ((dto.txn_type === 'Goods' || dto.txn_type === 'Inventory') ? '1200' : '5100');
      await this.ledger.postEntry({
        date: dto.invoice_date ?? ymd(), source: 'AP', sourceRef: txnNo, tenantId,
        memo: `AP bill ${txnNo}${dto.vendor_name ? ' ' + dto.vendor_name : ''}`, createdBy: user.username,
        lines: [{ account_code: expenseAccount, debit: net }, { account_code: '2100', debit: vat }, { account_code: '2000', credit: apGross }],
      });
    }
    await this.statusLog.log('AP', txnNo, '', status, user.username);
    return { txn_no: txnNo, status };
  }

  // ───────────────────── AP disbursement maker-checker (AP-PAY) ─────────────────────
  // Step 1 (MAKER, `creditors`) — REQUEST a vendor payment. No cash moves and NO GL posts here: the bill's
  // paid_amount is untouched and a PendingApproval row is recorded. PATCH /api/finance/ap/transactions/{no}/pay
  async requestApPayment(txnNo: string, amount: number, user: JwtUser, idempotencyKey?: string) {
    const db = this.db as any;
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
    const paymentNo = await this.docNo.nextDaily('APP');
    await db.insert(apPayments).values({
      paymentNo, txnNo, tenantId: apTenant, amount: String(n(amount)), status: 'PendingApproval',
      requestedBy: user.username, glRef: `${txnNo}:p:${paymentNo}`, idempotencyKey: idempotencyKey ?? null,
    });
    await this.statusLog.log('APP', paymentNo, '', 'PendingApproval', user.username, `Payment request ${n(amount)} for ${txnNo}`);
    return { payment_no: paymentNo, txn_no: txnNo, amount: n(amount), status: 'PendingApproval' };
  }

  // Step 2 (CHECKER, approval authority) — APPROVE a pending payment. The approver MUST differ from the
  // requester (segregation of duties) regardless of permissions held — even an Admin cannot approve their
  // own request. Only here does paid_amount move (under a row lock) and the cash-disbursement GL post.
  async approveApPayment(paymentNo: string, approver: JwtUser) {
    const db = this.db as any;
    const [p] = await db.select().from(apPayments).where(eq(apPayments.paymentNo, paymentNo)).limit(1);
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP payment not found', messageTh: 'ไม่พบรายการจ่าย' });
    if (p.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Payment ${paymentNo} is ${p.status}, not pending approval`, messageTh: 'รายการนี้ไม่ได้รออนุมัติ' });
    if (p.requestedBy && p.requestedBy === approver.username) {
      throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: you cannot approve a payment you requested', messageTh: 'ผู้ขอจ่ายอนุมัติรายการของตนเองไม่ได้ (แบ่งแยกหน้าที่)' });
    }
    const apTenant = p.tenantId ?? approver.tenantId ?? null;
    let newPaid = 0; let billStatus = '';
    await db.transaction(async (tx: any) => {
      // Lock the bill row and recompute from the LOCKED paid total → no lost update vs a concurrent approval.
      const [t] = await tx.select().from(apTransactions).where(eq(apTransactions.txnNo, p.txnNo)).for('update').limit(1);
      if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP txn not found', messageTh: 'ไม่พบรายการ AP' });
      newPaid = round2(n(t.paidAmount) + n(p.amount));
      billStatus = newPaid >= n(t.amount) ? 'Paid' : newPaid > 0 ? 'Partial' : 'Unpaid';
      await tx.update(apTransactions).set({ paidAmount: String(newPaid), status: billStatus }).where(eq(apTransactions.id, t.id));
      await tx.update(apPayments).set({ status: 'Approved', approvedBy: approver.username, approvedAt: new Date() }).where(eq(apPayments.id, p.id));
    });
    // GL: disburse (Dr 2000 AP / Cr 1000 Cash). The per-request glRef is stable + unique → idempotent post.
    if (this.ledger && n(p.amount) > 0 && !(await this.ledger.alreadyPosted('PAY-AP', p.glRef, apTenant))) {
      await this.ledger.postEntry({
        date: ymd(), source: 'PAY-AP', sourceRef: p.glRef, tenantId: apTenant,
        memo: `AP payment ${p.txnNo} (${paymentNo})`, createdBy: approver.username,
        lines: [{ account_code: '2000', debit: n(p.amount) }, { account_code: '1000', credit: n(p.amount) }],
      });
    }
    await this.statusLog.log('APP', paymentNo, 'PendingApproval', 'Approved', approver.username);
    return { payment_no: paymentNo, txn_no: p.txnNo, status: 'Approved', approved_by: approver.username, requested_by: p.requestedBy, paid_amount: newPaid, bill_status: billStatus };
  }

  // Step 2 (alt) — REJECT a pending payment (no cash/GL effect; recorded for the audit trail).
  async rejectApPayment(paymentNo: string, approver: JwtUser, reason?: string) {
    const db = this.db as any;
    const [p] = await db.select().from(apPayments).where(eq(apPayments.paymentNo, paymentNo)).limit(1);
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP payment not found', messageTh: 'ไม่พบรายการจ่าย' });
    if (p.status !== 'PendingApproval') throw new BadRequestException({ code: 'NOT_PENDING', message: `Payment ${paymentNo} is ${p.status}, not pending approval`, messageTh: 'รายการนี้ไม่ได้รออนุมัติ' });
    await db.update(apPayments).set({ status: 'Rejected', approvedBy: approver.username, approvedAt: new Date(), rejectReason: reason ?? null }).where(eq(apPayments.id, p.id));
    await this.statusLog.log('APP', paymentNo, 'PendingApproval', 'Rejected', approver.username, reason);
    return { payment_no: paymentNo, txn_no: p.txnNo, status: 'Rejected', rejected_by: approver.username };
  }

  // Checker queue — AP payments awaiting approval (joined to the bill for context).
  async listPendingApPayments(limit: number, offset: number) {
    const db = this.db as any;
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
    const db = this.db as any;
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
    const db = this.db as any;
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
  // approval (a control breakdown / bottleneck) before close. Spans the manual-JE (GL-05), AP-disbursement
  // (EXP-06), payroll (PAY-03), asset-revaluation (FA-08), asset-disposal (FA-09) and inventory-write-off
  // (INV-07) maker-checkers. Read-only; tenant-scoped via the caller's RLS (HQ/Admin sees every tenant).
  async pendingApprovals(opts?: { overdue_days?: number }) {
    const db = this.db as any;
    const overdueDays = opts?.overdue_days ?? 3;
    const ageDays = (d: any): number | null => (d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000)) : null);
    const items: any[] = [];

    // 1. GL-05 — manual journals posted as Draft, awaiting approval. Amount = Σ debit of the entry's lines.
    const drafts = await db.select().from(journalEntries).where(eq(journalEntries.status, 'Draft'));
    if (drafts.length) {
      const ids = drafts.map((e: any) => Number(e.id));
      const sums = await db.select({ entryId: journalLines.entryId, dr: sql<string>`coalesce(sum(${journalLines.debit}),0)` }).from(journalLines).where(inArray(journalLines.entryId, ids)).groupBy(journalLines.entryId);
      const byId = new Map<number, number>(sums.map((s: any) => [Number(s.entryId), n(s.dr)]));
      for (const e of drafts) items.push({ type: 'journal', control: 'GL-05', ref: e.entryNo, label: e.memo ?? 'Manual journal', amount: byId.get(Number(e.id)) ?? 0, requested_by: e.createdBy ?? null, requested_at: e.createdAt ?? null, age_days: ageDays(e.createdAt) });
    }
    // 2. EXP-06 — AP disbursements awaiting approval.
    for (const p of await db.select().from(apPayments).where(eq(apPayments.status, 'PendingApproval')))
      items.push({ type: 'ap_payment', control: 'EXP-06', ref: p.paymentNo, label: `จ่ายเจ้าหนี้ ${p.txnNo}`, amount: n(p.amount), requested_by: p.requestedBy ?? null, requested_at: p.requestedAt ?? null, age_days: ageDays(p.requestedAt) });
    // 3. PAY-03 — payroll runs awaiting approval.
    for (const r of await db.select().from(payruns).where(eq(payruns.status, 'PendingApproval')))
      items.push({ type: 'payroll', control: 'PAY-03', ref: r.period, label: `เงินเดือนงวด ${r.period} (${Number(r.headcount)} คน)`, amount: n(r.netTotal), requested_by: r.runBy ?? null, requested_at: r.runAt ?? null, age_days: ageDays(r.runAt) });
    // 4. FA-08 — asset revaluations/impairments awaiting approval.
    for (const v of await db.select().from(assetRevaluations).where(eq(assetRevaluations.status, 'PendingApproval')))
      items.push({ type: 'asset_revaluation', control: 'FA-08', ref: v.assetNo, label: `ตีมูลค่า ${v.assetNo} (${v.kind})`, amount: Math.abs(n(v.delta)), requested_by: v.actionedBy ?? null, requested_at: v.createdAt ?? null, age_days: ageDays(v.createdAt) });
    // 5. FA-09 — asset disposals awaiting approval (disposed_date is the requested date).
    for (const a of await db.select().from(fixedAssets).where(eq(fixedAssets.disposalPending, true)))
      items.push({ type: 'asset_disposal', control: 'FA-09', ref: a.assetNo, label: `จำหน่าย ${a.assetNo}`, amount: a.disposalProceeds != null ? n(a.disposalProceeds) : 0, requested_by: a.disposalRequestedBy ?? null, requested_at: a.disposedDate ?? null, age_days: ageDays(a.disposedDate) });
    // 6. INV-07 — inventory write-offs awaiting approval.
    for (const w of await db.select().from(invWriteoffRequests).where(eq(invWriteoffRequests.status, 'PendingApproval')))
      items.push({ type: 'inventory_writeoff', control: 'INV-07', ref: `WO-${Number(w.id)}`, label: `ตัดสต๊อก ${w.itemId} (${n(w.qtyDelta)})`, amount: n(w.estValue), requested_by: w.requestedBy ?? null, requested_at: w.createdAt ?? null, age_days: ageDays(w.createdAt) });
    // 7. EXP-08 — petty-cash expense / advance requests awaiting approval.
    for (const e of await db.select().from(expenseRequests).where(eq(expenseRequests.status, 'PendingApproval')))
      items.push({ type: 'petty_cash', control: 'EXP-08', ref: e.reqNo, label: `${e.kind === 'advance' ? 'เงินเบิกล่วงหน้า' : 'ค่าใช้จ่าย'} ${e.payee ?? ''}`.trim(), amount: n(e.amount), requested_by: e.requestedBy ?? null, requested_at: e.requestedAt ?? null, age_days: ageDays(e.requestedAt) });
    // 8. REV-13 — material till-close cash over/short awaiting a manager's approval.
    for (const t of await db.select().from(tillSessions).where(eq(tillSessions.varianceStatus, 'PendingApproval')))
      items.push({ type: 'till_variance', control: 'REV-13', ref: t.sessionNo, label: `เงินสด${n(t.variance) < 0 ? 'ขาด' : 'เกิน'} ${t.sessionNo}`, amount: Math.abs(n(t.variance)), requested_by: t.closedBy ?? null, requested_at: t.closedAt ?? null, age_days: ageDays(t.closedAt) });

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

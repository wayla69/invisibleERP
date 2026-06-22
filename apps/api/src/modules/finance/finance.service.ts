import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { sql, eq, ne, and, gte, lt, asc, inArray, notInArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, apTransactions, arInvoices, arReceipts, orders, orderLines, tenants } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { LedgerService } from '../ledger/ledger.service';
import { TaxService } from '../tax/tax.service';
import { ThreeWayMatchService } from '../match/three-way-match.service';
import { ymd, monthStart, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface ReceiptDto { invoice_no: string; amount: number; method?: string; ref_no?: string; remarks?: string }
export interface ApTxnDto { vendor_id?: number; vendor_name?: string; txn_type?: string; invoice_no?: string; invoice_date?: string; due_date?: string; amount: number; paid_amount?: number; remarks?: string; vat_treatment?: 'standard' | 'exempt' | 'zero' }

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

  // ───────────────────── WRITE (Phase 3) ─────────────────────
  // POST /api/finance/ar/sync — สร้าง INV-{order_no} จาก order ที่ Shipped/Completed ที่ยังไม่มี invoice
  async syncArInvoices(user: JwtUser) {
    const db = this.db as any;
    const candidates = await db.select({ id: orders.id, orderNo: orders.orderNo, orderDate: orders.orderDate, tenantId: orders.tenantId })
      .from(orders).where(sql`${orders.status}::text in ('Shipped','Completed')`);
    const existing = new Set((await db.select({ no: arInvoices.orderNo }).from(arInvoices)).map((r: any) => r.no));
    let created = 0;
    for (const o of candidates) {
      if (existing.has(o.orderNo)) continue;
      const [amt] = await db.select({ a: sql<string>`coalesce(sum(${orderLines.totalPrice}),0)` }).from(orderLines).where(eq(orderLines.orderId, o.id));
      let termDays = 30;
      if (o.tenantId != null) {
        const [t] = await db.select({ ct: tenants.creditTerm }).from(tenants).where(eq(tenants.id, o.tenantId)).limit(1);
        termDays = parseInt(String(t?.ct ?? '').replace(/\D/g, ''), 10) || 30;
      }
      const invoiceNo = this.docNo.invoiceFromOrder(o.orderNo);
      await db.insert(arInvoices).values({
        invoiceNo, invoiceDate: o.orderDate, dueDate: addDays(o.orderDate, termDays),
        tenantId: o.tenantId, orderNo: o.orderNo, amount: amt.a, paidAmount: '0', status: 'Unpaid', createdBy: 'system',
      }).onConflictDoNothing();
      // GL: recognize receivable + revenue + output VAT (Dr 1100 / Cr 4000 net / Cr 2100 vat)
      const grossAmt = n(amt.a);
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
    const receiptNo = await this.docNo.nextDaily('RCP');
    const newPaid = n(inv.paidAmount) + n(dto.amount);
    const status = newPaid >= n(inv.amount) ? 'Paid' : 'Partial';
    await db.transaction(async (tx: any) => {
      await tx.insert(arReceipts).values({
        receiptNo, receiptDate: ymd(), tenantId: inv.tenantId, invoiceNo: dto.invoice_no, amount: String(n(dto.amount)),
        method: dto.method ?? 'Transfer', refNo: dto.ref_no ?? null, remarks: dto.remarks ?? null, createdBy: user.username,
      });
      await tx.update(arInvoices).set({ paidAmount: String(newPaid), status }).where(eq(arInvoices.id, inv.id));
    });
    // GL: collect cash against the receivable (Dr 1000 Cash / Cr 1100 AR)
    if (this.ledger && n(dto.amount) > 0) {
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
    const txnNo = await this.docNo.nextDaily('AP');
    const paid = n(dto.paid_amount);
    const status = paid >= n(dto.amount) ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid';
    const apGross = n(dto.amount);
    // input VAT — exempt/zero-rated/non-VAT bills carry NO input VAT (else ภ.พ.30 overstates the credit).
    const treatment = dto.vat_treatment ?? 'standard';
    const { net, vat } = treatment === 'standard' ? this.vatSplit(apGross) : { net: apGross, vat: 0 };
    const tenantId = user.tenantId ?? null; // input VAT is per shop (ภ.พ.30) → tenant-scoped like output VAT
    await db.insert(apTransactions).values({
      txnNo, tenantId, vendorId: dto.vendor_id ?? null, vendorName: dto.vendor_name ?? null, txnType: dto.txn_type ?? 'Invoice',
      invoiceNo: dto.invoice_no ?? null, invoiceDate: dto.invoice_date ?? null, dueDate: dto.due_date ?? null,
      amount: String(apGross), vatAmount: fx(vat, 2), paidAmount: String(paid), status, remarks: dto.remarks ?? null, createdBy: user.username,
    });
    // GL: record expense + input VAT + payable (Dr 5100/1200 net / Dr 2100 vat / Cr 2000 gross). Zero VAT leg auto-drops.
    if (this.ledger && apGross > 0) {
      const expenseAccount = (dto.txn_type === 'Goods' || dto.txn_type === 'Inventory') ? '1200' : '5100';
      await this.ledger.postEntry({
        date: dto.invoice_date ?? ymd(), source: 'AP', sourceRef: txnNo, tenantId,
        memo: `AP bill ${txnNo}${dto.vendor_name ? ' ' + dto.vendor_name : ''}`, createdBy: user.username,
        lines: [{ account_code: expenseAccount, debit: net }, { account_code: '2100', debit: vat }, { account_code: '2000', credit: apGross }],
      });
    }
    await this.statusLog.log('AP', txnNo, '', status, user.username);
    return { txn_no: txnNo, status };
  }

  // PATCH /api/finance/ap/transactions/{no}/pay
  async payAp(txnNo: string, amount: number, user: JwtUser) {
    const db = this.db as any;
    const [t] = await db.select().from(apTransactions).where(eq(apTransactions.txnNo, txnNo)).limit(1);
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: 'AP txn not found', messageTh: 'ไม่พบรายการ AP' });
    // Phase 16 — 3-way match gate: a PO-based invoice must pass match (or be overridden) before payment.
    if (this.matchSvc) await this.matchSvc.assertPayable(txnNo);
    const newPaid = n(t.paidAmount) + n(amount);
    const status = newPaid >= n(t.amount) ? 'Paid' : newPaid > 0 ? 'Partial' : 'Unpaid';
    await db.update(apTransactions).set({ paidAmount: String(newPaid), status }).where(eq(apTransactions.id, t.id));
    // GL: pay the payable (Dr 2000 AP / Cr 1000 Cash). Tag the entry to the AP txn's tenant (not null),
    // keyed per-payment (running paid total) and guarded so a retry of the same installment posts once.
    const apTenant = t.tenantId ?? user.tenantId ?? null;
    const payRef = `${txnNo}:${newPaid}`;
    if (this.ledger && n(amount) > 0 && !(await this.ledger.alreadyPosted('PAY-AP', payRef, apTenant))) {
      await this.ledger.postEntry({
        date: ymd(), source: 'PAY-AP', sourceRef: payRef, tenantId: apTenant,
        memo: `AP payment ${txnNo}`, createdBy: user.username,
        lines: [{ account_code: '2000', debit: n(amount) }, { account_code: '1000', credit: n(amount) }],
      });
    }
    await this.statusLog.log('AP', txnNo, t.status ?? '', status, user.username);
    return { txn_no: txnNo, paid_amount: newPaid, status };
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
}

function round2(x: number) { return Math.round(x * 100) / 100; }
function addDays(dateStr: string | null, days: number): string {
  const d = dateStr ? new Date(dateStr) : new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

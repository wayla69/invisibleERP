import { NotFoundException } from '@nestjs/common';
import { sql, eq, and, desc } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { apTransactions, apPayments, arInvoices, arReceipts, arReceiptApplications, orders, orderLines, tenants } from '../../database/schema';
import { vendors as vendorsTbl } from '../../database/schema';
import { n } from '../../database/queries';
import { roundCurrency } from '../tax/money';
import { ArInvoicePdfService, type ArInvoicePrintData } from './ar-invoice-pdf.service';
import { FinanceDocsPdfService, type StatementPrintData, type ArReceiptPrintData } from './finance-docs-pdf.service';
import { DocEmailService } from '../mail/doc-email.service';
import { sellerParty } from '../../common/doc-party';
import type { DocParty } from '../../common/doc-html';
import type { JwtUser } from '../../common/decorators';

// docs/46 Phase 4a cut 1 — the customer/vendor DOCUMENT surface of finance (statements of account,
// AR billing invoices, AR receipt vouchers: assemble → HTML → PDF → email), moved VERBATIM out of
// finance.service.ts. A plain class constructed in the FinanceService constructor BODY (the writeflow
// harness constructs the facade positionally with 3 args, so sub-services are never DI params — docs/38
// recipe); every public method below keeps a thin delegator on the facade, so the public API is
// byte-identical. Renderer/email deps stay optional exactly as they were on the facade.
export class FinanceDocumentsService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly arInvoicePdf?: ArInvoicePdfService,
    private readonly docEmail?: DocEmailService,
    private readonly finDocsPdf?: FinanceDocsPdfService,
  ) {}

  // Resolve the caller's own tenant profile as the document issuer (our-company header).
  private async sellerFor(user: JwtUser): Promise<DocParty> {
    const [t] = user.tenantId != null ? await this.db.select().from(tenants).where(eq(tenants.id, Number(user.tenantId))).limit(1) : [null];
    return sellerParty(t);
  }

  // Assemble the printable ใบแจ้งหนี้/ใบวางบิล (AR billing invoice — NOT the statutory ใบกำกับภาษี).
  // Seller = the caller's company (tenant); customer = the invoice's tenant (the finance AR list already
  // treats arInvoices.tenantId as the customer). Line detail is drawn from the linked sales order; with no
  // order lines a single summary line carries the invoice amount.
  async getArInvoiceForPrint(invoiceNo: string, user: JwtUser): Promise<ArInvoicePrintData> {
    const db = this.db;
    const [inv] = await db.select().from(arInvoices).where(eq(arInvoices.invoiceNo, invoiceNo)).limit(1);
    if (!inv) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Invoice not found', messageTh: 'ไม่พบใบแจ้งหนี้' });
    const [seller] = user.tenantId != null ? await db.select().from(tenants).where(eq(tenants.id, Number(user.tenantId))).limit(1) : [null];
    const [cust] = inv.tenantId != null ? await db.select().from(tenants).where(eq(tenants.id, Number(inv.tenantId))).limit(1) : [null];
    let lines: ArInvoicePrintData['lines'] = [];
    if (inv.orderNo) {
      const [o] = await db.select().from(orders).where(eq(orders.orderNo, inv.orderNo)).limit(1);
      if (o) {
        const ols = await db.select().from(orderLines).where(eq(orderLines.orderId, Number(o.id)));
        lines = ols.map((l: any) => ({ description: l.itemDescription ?? l.itemId ?? '', qty: n(l.orderQty) || 1, unit_price: n(l.unitPrice), amount: n(l.totalPrice ?? n(l.orderQty) * n(l.unitPrice)) }));
      }
    }
    const amount = n(inv.amount);
    if (!lines.length) lines = [{ description: inv.orderNo ? `ตามใบสั่งขาย ${inv.orderNo}` : 'ยอดตามใบแจ้งหนี้', qty: 1, unit_price: amount, amount }];
    const subtotal = lines.reduce((a, l) => a + l.amount, 0);
    const paid = n(inv.paidAmount);
    return {
      invoice_no: inv.invoiceNo, invoice_date: inv.invoiceDate ?? null, due_date: inv.dueDate ?? null,
      status: String(inv.status ?? ''), currency: inv.currency ?? 'THB', order_no: inv.orderNo ?? null,
      seller: sellerParty(seller),
      customer: cust ? sellerParty(cust) : { name: 'ลูกค้า', address: '-', tax_id: null, branch_label: null, phone: null, email: null },
      lines, subtotal, amount, paid_amount: paid, balance: Math.round((amount - paid) * 100) / 100,
    };
  }

  arInvoiceHtml(inv: ArInvoicePrintData): string {
    if (!this.arInvoicePdf) throw new NotFoundException({ code: 'RENDERER_UNAVAILABLE', message: 'AR invoice renderer not wired' });
    return this.arInvoicePdf.arInvoiceHtml(inv);
  }

  async renderArInvoicePdf(inv: ArInvoicePrintData): Promise<Buffer | null> {
    return this.arInvoicePdf ? this.arInvoicePdf.renderToPdf(this.arInvoicePdf.arInvoiceHtml(inv)) : null;
  }

  // Email the ใบแจ้งหนี้/ใบวางบิล to the customer as a PDF attachment (HTML fallback when Chromium absent).
  async emailArInvoice(invoiceNo: string, toEmail: string | undefined, user: JwtUser) {
    if (!this.docEmail) throw new NotFoundException({ code: 'EMAIL_UNAVAILABLE', message: 'Email path not wired' });
    const inv = await this.getArInvoiceForPrint(invoiceNo, user);
    // Default the recipient to the customer's email on file (master data) when the caller omits to_email;
    // DocEmailService raises NO_RECIPIENT if neither is present.
    const res = await this.docEmail.sendDocument({
      to: toEmail?.trim() || inv.customer.email || '', from: inv.seller.email ?? undefined, filename: inv.invoice_no,
      subject: `ใบแจ้งหนี้ ${inv.invoice_no} จาก ${inv.seller.name}`,
      text: `เรียน ${inv.customer.name},\n\nแนบใบแจ้งหนี้เลขที่ ${inv.invoice_no} จำนวนเงิน ${inv.amount.toLocaleString()} ${inv.currency} (ครบกำหนดชำระ ${inv.due_date ?? '-'})\n\nขอบคุณครับ\n${inv.seller.name}`,
      html: this.arInvoiceHtml(inv),
    });
    return { ...res, invoice_no: inv.invoice_no };
  }

  // ── ใบแจ้งยอดบัญชี (Statement of account) — print/email over the running-balance statement ──
  async getCustomerStatementForPrint(tenantId: number, from: string | undefined, to: string | undefined, currency: string | undefined, user: JwtUser): Promise<StatementPrintData> {
    const s = await this.customerStatement(tenantId, from, to, currency);
    const [cust] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return this.toStatementPrint(s, 'customer', cust?.legalName || cust?.name || `ลูกค้า #${tenantId}`, cust?.taxId ?? null, cust?.email ?? null, await this.sellerFor(user));
  }

  async getVendorStatementForPrint(vendor: string, from: string | undefined, to: string | undefined, currency: string | undefined, user: JwtUser): Promise<StatementPrintData> {
    const s = await this.vendorStatement(vendor, from, to, currency);
    const [v] = await this.db.select().from(vendorsTbl).where(eq(vendorsTbl.name, vendor)).limit(1);
    return this.toStatementPrint(s, 'vendor', vendor, v?.taxId ?? null, v?.email ?? null, await this.sellerFor(user));
  }

  private toStatementPrint(s: any, party_type: 'customer' | 'vendor', party_name: string, party_tax_id: string | null, party_email: string | null, seller: DocParty): StatementPrintData {
    return {
      party_type, party_name, party_tax_id, party_email, from: s.from, to: s.to, reporting_currency: s.reporting_currency,
      opening_balance: s.opening_balance, total_charges: s.total_charges, total_payments: s.total_payments, closing_balance: s.closing_balance,
      lines: (s.lines ?? []).map((l: any) => ({ date: l.date, type: l.type, ref: l.ref, charge: n(l.charge), payment: n(l.payment), balance: n(l.balance) })),
      seller,
    };
  }

  statementHtml(s: StatementPrintData): string {
    if (!this.finDocsPdf) throw new NotFoundException({ code: 'RENDERER_UNAVAILABLE', message: 'Statement renderer not wired' });
    return this.finDocsPdf.statementHtml(s);
  }
  renderStatementPdf(s: StatementPrintData): Promise<Buffer | null> { return this.finDocsPdf ? this.finDocsPdf.renderToPdf(this.finDocsPdf.statementHtml(s)) : Promise.resolve(null); }

  async emailStatement(s: StatementPrintData, toEmail: string | undefined) {
    if (!this.docEmail) throw new NotFoundException({ code: 'EMAIL_UNAVAILABLE', message: 'Email path not wired' });
    const fname = `statement-${s.party_type}-${s.to}`;
    // Default the recipient to the party's email on file (master data) when to_email is omitted.
    const res = await this.docEmail.sendDocument({
      to: toEmail?.trim() || s.party_email || '', from: s.seller.email ?? undefined, filename: fname,
      subject: `ใบแจ้งยอดบัญชี ${s.party_name} (${s.from} – ${s.to})`,
      text: `แนบใบแจ้งยอดบัญชี ยอดคงเหลือสุทธิ ${s.closing_balance.toLocaleString()} ${s.reporting_currency}\n\n${s.seller.name}`,
      html: this.statementHtml(s),
    });
    return { ...res };
  }

  // Recent AR receipts (for the finance list surface — print/email each ใบสำคัญรับเงิน). RLS-scoped.
  async listArReceipts(_user: JwtUser, limit = 50) {
    const rows = await this.db.select().from(arReceipts).orderBy(desc(arReceipts.id)).limit(Math.min(Math.max(limit, 1), 100));
    return { receipts: rows.map((r: any) => ({ receipt_no: r.receiptNo, receipt_date: r.receiptDate ?? null, invoice_no: r.invoiceNo ?? null, amount: n(r.amount), unapplied: n(r.unappliedAmount), method: r.method ?? 'Transfer', ref_no: r.refNo ?? null })), count: rows.length };
  }

  // ── ใบสำคัญรับเงิน (AR receipt voucher) — print/email over an ar_receipts row ──
  async getArReceiptForPrint(receiptNo: string, user: JwtUser): Promise<ArReceiptPrintData> {
    const db = this.db;
    const [rc] = await db.select().from(arReceipts).where(eq(arReceipts.receiptNo, receiptNo)).limit(1);
    if (!rc) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Receipt not found', messageTh: 'ไม่พบใบสำคัญรับเงิน' });
    const [cust] = rc.tenantId != null ? await db.select().from(tenants).where(eq(tenants.id, Number(rc.tenantId))).limit(1) : [null];
    return {
      receipt_no: rc.receiptNo, receipt_date: rc.receiptDate ?? null, invoice_no: rc.invoiceNo ?? null,
      amount: n(rc.amount), method: rc.method ?? 'Transfer', ref_no: rc.refNo ?? null, currency: 'THB',
      customer: cust ? sellerParty(cust) : { name: 'ลูกค้า', address: '-', tax_id: null, branch_label: null, phone: null, email: null },
      seller: await this.sellerFor(user),
    };
  }
  arReceiptHtml(r: ArReceiptPrintData): string {
    if (!this.finDocsPdf) throw new NotFoundException({ code: 'RENDERER_UNAVAILABLE', message: 'Receipt renderer not wired' });
    return this.finDocsPdf.arReceiptHtml(r);
  }
  renderArReceiptPdf(r: ArReceiptPrintData): Promise<Buffer | null> { return this.finDocsPdf ? this.finDocsPdf.renderToPdf(this.finDocsPdf.arReceiptHtml(r)) : Promise.resolve(null); }
  async emailArReceipt(receiptNo: string, toEmail: string | undefined, user: JwtUser) {
    if (!this.docEmail) throw new NotFoundException({ code: 'EMAIL_UNAVAILABLE', message: 'Email path not wired' });
    const r = await this.getArReceiptForPrint(receiptNo, user);
    // Default the recipient to the customer's email on file (master data) when to_email is omitted.
    const res = await this.docEmail.sendDocument({
      to: toEmail?.trim() || r.customer.email || '', from: r.seller.email ?? undefined, filename: r.receipt_no,
      subject: `ใบสำคัญรับเงิน ${r.receipt_no} จาก ${r.seller.name}`,
      text: `แนบใบสำคัญรับเงินเลขที่ ${r.receipt_no} จำนวนเงิน ${r.amount.toLocaleString()} ${r.currency}\n\n${r.seller.name}`,
      html: this.arReceiptHtml(r),
    });
    return { ...res, receipt_no: r.receipt_no };
  }

  // A running-balance statement over [from,to]: opening balance struck before the window, then every
  // charge (invoice/bill) and payment (receipt/disbursement) in date order, with a closing balance.
  // Multi-currency: each document keeps its own currency + booked fx rate. With no `currency` filter the
  // statement reports in base THB (each doc converted at its fx rate); with `?currency=USD` it reports only
  // that currency's documents in their own units. A receipt/payment inherits the currency of the invoice/
  // bill it settles.
  async customerStatement(tenantId: number, from?: string, to?: string, currency?: string) {
    const db = this.db;
    const lo = from ?? '0001-01-01';
    const hi = to ?? '9999-12-31';
    const invs = await db.select({ date: arInvoices.invoiceDate, ref: arInvoices.invoiceNo, amt: arInvoices.amount, cur: arInvoices.currency, fx: arInvoices.fxRate }).from(arInvoices).where(eq(arInvoices.tenantId, tenantId));
    const invByNo = new Map<string, { cur: string; fx: number }>(invs.map((i: any) => [i.ref, { cur: i.cur ?? 'THB', fx: n(i.fx) || 1 }]));
    const rcps = await db.select({ date: arReceipts.receiptDate, ref: arReceipts.receiptNo, amt: arReceipts.amount, inv: arReceipts.invoiceNo }).from(arReceipts).where(eq(arReceipts.tenantId, tenantId));
    // REV-21 — an applied credit note reduces what the customer owes: each effective (applied, not
    // reversed) credit-note application is a statement credit dated on its application day, in the target
    // invoice's currency. Cash receipts already appear in full (incl. their on-account remainder), so a
    // multi-invoice/on-account receipt nets the statement exactly once.
    const cnApps = await db.select({
      date: sql<string>`${arReceiptApplications.appliedAt}::date`, ref: arReceiptApplications.receiptNo,
      inv: arReceiptApplications.invoiceNo, amt: arReceiptApplications.appliedAmount,
    }).from(arReceiptApplications).where(and(
      eq(arReceiptApplications.tenantId, tenantId), eq(arReceiptApplications.sourceType, 'credit_note'),
      eq(arReceiptApplications.status, 'applied'), eq(arReceiptApplications.reversed, false),
    ));
    const events = [
      ...invs.map((i: any) => ({ date: i.date, type: 'invoice', ref: i.ref, cur: i.cur ?? 'THB', fx: n(i.fx) || 1, charge: n(i.amt), payment: 0 })),
      ...rcps.map((rc: any) => { const k = invByNo.get(rc.inv) ?? { cur: 'THB', fx: 1 }; return { date: rc.date, type: 'receipt', ref: rc.ref, cur: k.cur, fx: k.fx, charge: 0, payment: n(rc.amt) }; }),
      ...cnApps.map((c: any) => { const k = invByNo.get(c.inv) ?? { cur: 'THB', fx: 1 }; return { date: c.date, type: 'credit_note', ref: c.ref, cur: k.cur, fx: k.fx, charge: 0, payment: n(c.amt) }; }),
    ];
    return this.buildStatement('customer', String(tenantId), events, lo, hi, currency);
  }

  async vendorStatement(vendor: string, from?: string, to?: string, currency?: string) {
    const db = this.db;
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
        doc_charge: roundCurrency(e.charge, e.cur), doc_payment: roundCurrency(e.payment, e.cur),
        charge: roundCurrency(currency ? e.charge : e.charge * e.fx, reporting),
        payment: roundCurrency(currency ? e.payment : e.payment * e.fx, reporting),
      }));
    const opening = roundCurrency(evs.filter((e) => String(e.date ?? '') < from).reduce((a, e) => a + e.charge - e.payment, 0), reporting);
    const win = evs.filter((e) => { const d = String(e.date ?? ''); return d >= from && d <= to; });
    win.sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || String(a.ref).localeCompare(String(b.ref)));
    let bal = opening;
    const lines = win.map((e) => { bal = roundCurrency(bal + e.charge - e.payment, reporting); return { ...e, balance: bal }; });
    const charges = roundCurrency(win.reduce((a, e) => a + e.charge, 0), reporting);
    const payments = roundCurrency(win.reduce((a, e) => a + e.payment, 0), reporting);
    return { party_type, party, reporting_currency: reporting, from, to, opening_balance: opening, total_charges: charges, total_payments: payments, closing_balance: roundCurrency(opening + charges - payments, reporting), lines };
  }
}

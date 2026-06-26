import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { and, eq, gte, lt, asc, desc, isNotNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { taxInvoices, apTransactions, whtCertificates, whtCertLines, journalLines, journalEntries, thaiTaxFilings } from '../../database/schema';
import { n } from '../../database/queries';
import { PND_LABELS } from '../tax-docs/wht-rates';
import { currentTenantStore } from '../../common/tenant-context';
import { NotFoundException } from '@nestjs/common';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const nextMonthDay = (month: number, year: number, day: number) => {
  const m = month < 12 ? month + 1 : 1; const y = month < 12 ? year : year + 1;
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

@Injectable()
export class TaxReportsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private win(month: number, year: number) {
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const end = month < 12 ? `${year}-${String(month + 1).padStart(2, '0')}-01` : `${year + 1}-01-01`;
    return { start, end, period: `${year}-${String(month).padStart(2, '0')}` };
  }

  // รายงานภาษีขาย (output VAT) — from issued tax invoices (RLS scopes to the seller)
  async outputVat(month: number, year: number) {
    const db = this.db as any; const { start, end, period } = this.win(month, year);
    const rows = await db.select({
      date: taxInvoices.issueDate, doc_no: taxInvoices.docNo, type: taxInvoices.type,
      buyer_name: taxInvoices.buyerName, buyer_tax_id: taxInvoices.buyerTaxId, value: taxInvoices.subtotal, vat: taxInvoices.vatAmount,
    }).from(taxInvoices).where(and(eq(taxInvoices.status, 'Issued'), gte(taxInvoices.issueDate, start), lt(taxInvoices.issueDate, end))).orderBy(asc(taxInvoices.issueDate), asc(taxInvoices.docNo));
    const out = rows.map((r: any) => ({ date: r.date, doc_no: r.doc_no, type: r.type, buyer_name: r.buyer_name ?? 'เงินสด', buyer_tax_id: r.buyer_tax_id ?? '-', value: n(r.value), vat: n(r.vat) }));
    return { report: 'output_vat', month, year, period, rows: out, abbreviated_count: out.filter((r: any) => r.type === 'abbreviated').length, totals: { value: round2(out.reduce((a: number, r: any) => a + r.value, 0)), vat: round2(out.reduce((a: number, r: any) => a + r.vat, 0)), count: out.length } };
  }

  // รายงานภาษีซื้อ (input VAT) — from AP bills (AP is tenant-global, exec/creditors only)
  async inputVat(month: number, year: number) {
    const db = this.db as any; const { start, end, period } = this.win(month, year);
    const rows = await db.select({
      date: apTransactions.invoiceDate, doc_no: apTransactions.txnNo, invoice_no: apTransactions.invoiceNo,
      vendor_name: apTransactions.vendorName, amount: apTransactions.amount,
      vat: sql<string>`coalesce(${apTransactions.vatAmount}, round(${apTransactions.amount}*7.0/107.0,2))`,
    }).from(apTransactions).where(and(isNotNull(apTransactions.invoiceDate), gte(apTransactions.invoiceDate, start), lt(apTransactions.invoiceDate, end))).orderBy(asc(apTransactions.invoiceDate), asc(apTransactions.txnNo));
    const out = rows.map((r: any) => ({ date: r.date, doc_no: r.doc_no, invoice_no: r.invoice_no, vendor_name: r.vendor_name, vendor_tax_id: null, base: round2(n(r.amount) - n(r.vat)), vat: n(r.vat) }));
    return { report: 'input_vat', month, year, period, rows: out, totals: { base: round2(out.reduce((a: number, r: any) => a + r.base, 0)), vat: round2(out.reduce((a: number, r: any) => a + r.vat, 0)), count: out.length } };
  }

  // ภ.พ.30 — output − input, reconciled to GL account 2100 movement
  async pp30(month: number, year: number) {
    const { start, end, period } = this.win(month, year);
    const out = await this.outputVat(month, year);
    const inp = await this.inputVat(month, year);
    const outputTax = out.totals.vat, inputTax = inp.totals.vat;
    const netVat = round2(outputTax - inputTax);
    const db = this.db as any;
    const [g] = await db.select({ v: sql<string>`coalesce(sum(${journalLines.credit}) - sum(${journalLines.debit}),0)` })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalLines.accountCode, '2100'), eq(journalEntries.status, 'Posted'), gte(journalEntries.entryDate, start), lt(journalEntries.entryDate, end)));
    const gl2100Net = round2(n(g?.v));
    return {
      report: 'pp30', month, year, period,
      form: { sales_taxable: out.totals.value, output_vat: outputTax, purchases: inp.totals.base, input_vat: inputTax, vat_payable: netVat > 0 ? netVat : 0, vat_credit_carry_forward: netVat < 0 ? -netVat : 0 },
      reconciliation: { gl_account: '2100', gl_net_movement: gl2100Net, report_net_vat: netVat, tied: Math.abs(gl2100Net - netVat) < 0.01, scope_note: 'AR legs of 2100 are tenant-tagged; AP legs are tenant-null — tie is exact under HQ/bypass or single-seller scope.' },
      deadline: nextMonthDay(month, year, 15),
      deadline_note: 'ยื่นแบบ ภ.พ.30 ภายในวันที่ 15 ของเดือนถัดไป',
    };
  }

  // ภ.ง.ด.3 / ภ.ง.ด.53 — WHT remittance from 50-tawi certificates
  async pnd(type: string, month: number, year: number) {
    if (type !== 'PND3' && type !== 'PND53') throw new BadRequestException({ code: 'BAD_PND', message: 'type must be PND3 or PND53', messageTh: 'ประเภทต้องเป็น PND3 หรือ PND53' });
    const db = this.db as any; const { start, end, period } = this.win(month, year);
    const rows = await db.select({
      doc_no: whtCertificates.docNo, date_paid: whtCertificates.datePaid, payee_name: whtCertificates.payeeName, payee_tax_id: whtCertificates.payeeTaxId,
      income_type: whtCertLines.incomeType, amount_paid: whtCertLines.amountPaid, rate: whtCertLines.rate, tax_withheld: whtCertLines.taxWithheld,
    }).from(whtCertLines).innerJoin(whtCertificates, eq(whtCertLines.whtCertId, whtCertificates.id))
      .where(and(eq(whtCertificates.pndType, type as any), eq(whtCertificates.status, 'Issued'), gte(whtCertificates.datePaid, start), lt(whtCertificates.datePaid, end)))
      .orderBy(asc(whtCertificates.datePaid), asc(whtCertificates.docNo));
    const out = rows.map((r: any) => ({ doc_no: r.doc_no, date_paid: r.date_paid, payee_name: r.payee_name, payee_tax_id: r.payee_tax_id, income_type: r.income_type, amount_paid: n(r.amount_paid), rate: n(r.rate), tax_withheld: n(r.tax_withheld) }));
    return {
      report: 'pnd', pnd_type: type, pnd_label: (PND_LABELS as any)[type], month, year, period, rows: out,
      totals: { amount_paid: round2(out.reduce((a: number, r: any) => a + r.amount_paid, 0)), tax_withheld: round2(out.reduce((a: number, r: any) => a + r.tax_withheld, 0)), count: out.length },
      deadline: nextMonthDay(month, year, 7),
      deadline_note: 'ยื่นแบบ ภ.ง.ด. ภายในวันที่ 7 ของเดือนถัดไป',
    };
  }

  // ───────────────────── Filing register (TAX-05) ─────────────────────
  private tenantId(): number | null { return currentTenantStore()?.tenantId ?? null; }

  // File a return: snapshot the computed PP30/PND figures into a DRAFT filing (idempotent per
  // tenant/type/period). A return already SUBMITTED/ACCEPTED is returned as-is (you don't silently
  // overwrite a filed return); a DRAFT is refreshed to the latest computed figures.
  async fileReturn(type: string, month: number, year: number, user: JwtUser) {
    const db = this.db as any;
    const tenantId = this.tenantId();
    const ft = type.toUpperCase();
    if (!['PP30', 'PND3', 'PND53'].includes(ft)) throw new BadRequestException({ code: 'BAD_FILING_TYPE', message: 'filing_type must be PP30/PND3/PND53', messageTh: 'ประเภทแบบต้องเป็น PP30/PND3/PND53' });
    let outputVat = 0, inputVat = 0, netVat = 0, taxWithheld = 0, deadline: string, snapshot: any;
    if (ft === 'PP30') {
      const r = await this.pp30(month, year);
      outputVat = r.form.output_vat; inputVat = r.form.input_vat; netVat = round2(r.form.vat_payable - r.form.vat_credit_carry_forward); deadline = r.deadline; snapshot = r;
    } else {
      const r = await this.pnd(ft, month, year); taxWithheld = r.totals.tax_withheld; deadline = r.deadline; snapshot = r;
    }
    const [existing] = await db.select().from(thaiTaxFilings)
      .where(and(eq(thaiTaxFilings.filingType, ft), eq(thaiTaxFilings.periodMonth, month), eq(thaiTaxFilings.periodYear, year))).limit(1);
    if (existing && existing.status !== 'DRAFT') return { ...this.shapeFiling(existing), already_filed: true };
    const values = { tenantId: tenantId as number, filingType: ft, periodMonth: month, periodYear: year, status: 'DRAFT',
      outputVat: String(outputVat), inputVat: String(inputVat), netVat: String(netVat), taxWithheld: String(taxWithheld),
      deadline, snapshot, createdBy: user.username };
    if (existing) {
      await db.update(thaiTaxFilings).set(values).where(eq(thaiTaxFilings.id, existing.id));
      return { ...this.shapeFiling({ ...existing, ...values }), already_filed: false };
    }
    const [row] = await db.insert(thaiTaxFilings).values(values).returning();
    return { ...this.shapeFiling(row), already_filed: false };
  }

  // Submit a DRAFT filing to the Revenue Department: requires a submission reference; stamps SUBMITTED.
  async submitFiling(id: number, submissionRef: string, _user: JwtUser) {
    const db = this.db as any;
    const [f] = await db.select().from(thaiTaxFilings).where(eq(thaiTaxFilings.id, id)).limit(1);
    if (!f) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Filing not found', messageTh: 'ไม่พบแบบยื่น' });
    if (f.status !== 'DRAFT') throw new BadRequestException({ code: 'NOT_DRAFT', message: `Filing is ${f.status}, not DRAFT`, messageTh: 'ยื่นได้เฉพาะแบบที่เป็นฉบับร่าง' });
    if (!submissionRef || !submissionRef.trim()) throw new BadRequestException({ code: 'SUBMISSION_REF_REQUIRED', message: 'A submission reference is required', messageTh: 'ต้องระบุเลขอ้างอิงการยื่น' });
    await db.update(thaiTaxFilings).set({ status: 'SUBMITTED', submittedAt: new Date(), submissionRef: submissionRef.trim() }).where(eq(thaiTaxFilings.id, id));
    return this.shapeFiling((await db.select().from(thaiTaxFilings).where(eq(thaiTaxFilings.id, id)).limit(1))[0]);
  }

  // Mark a SUBMITTED filing ACCEPTED (RD acknowledgement).
  async acceptFiling(id: number, _user: JwtUser) {
    const db = this.db as any;
    const [f] = await db.select().from(thaiTaxFilings).where(eq(thaiTaxFilings.id, id)).limit(1);
    if (!f) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Filing not found', messageTh: 'ไม่พบแบบยื่น' });
    if (f.status !== 'SUBMITTED') throw new BadRequestException({ code: 'NOT_SUBMITTED', message: `Filing is ${f.status}, not SUBMITTED`, messageTh: 'รับรองได้เฉพาะแบบที่ยื่นแล้ว' });
    await db.update(thaiTaxFilings).set({ status: 'ACCEPTED' }).where(eq(thaiTaxFilings.id, id));
    return this.shapeFiling((await db.select().from(thaiTaxFilings).where(eq(thaiTaxFilings.id, id)).limit(1))[0]);
  }

  async listFilings(opts?: { year?: number }) {
    const db = this.db as any;
    const rows = await db.select().from(thaiTaxFilings)
      .where(opts?.year ? eq(thaiTaxFilings.periodYear, opts.year) : sql`true`)
      .orderBy(desc(thaiTaxFilings.periodYear), desc(thaiTaxFilings.periodMonth), asc(thaiTaxFilings.filingType));
    return { filings: rows.map((r: any) => this.shapeFiling(r)), count: rows.length };
  }

  // Remittance calendar: every monthly filing obligation for the year (PP30 by the 15th, PND by the 7th of
  // the following month) with the current filing status, so the controller sees what is due / filed / late.
  async remittanceCalendar(year: number) {
    const db = this.db as any;
    const rows = await db.select().from(thaiTaxFilings).where(eq(thaiTaxFilings.periodYear, year));
    const byKey = new Map<string, any>(rows.map((r: any) => [`${r.filingType}|${r.periodMonth}`, r]));
    const out: any[] = [];
    for (let m = 1; m <= 12; m++) {
      for (const [type, day] of [['PP30', 15], ['PND53', 7], ['PND3', 7]] as [string, number][]) {
        const f = byKey.get(`${type}|${m}`);
        out.push({
          filing_type: type, period_month: m, period_year: year, deadline: nextMonthDay(m, year, day),
          status: f?.status ?? 'NOT_FILED', filing_id: f ? Number(f.id) : null,
          submission_ref: f?.submissionRef ?? null,
        });
      }
    }
    return { year, calendar: out };
  }

  private shapeFiling(r: any) {
    return {
      id: Number(r.id), filing_type: r.filingType, period_month: r.periodMonth, period_year: r.periodYear,
      status: r.status, output_vat: n(r.outputVat), input_vat: n(r.inputVat), net_vat: n(r.netVat),
      tax_withheld: n(r.taxWithheld), deadline: r.deadline, submitted_at: r.submittedAt, submission_ref: r.submissionRef,
      created_by: r.createdBy,
    };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { apPayments, apTransactions, vendors, whtCertificates } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { WhtService } from './documents/wht.service';
import type { IssueWhtDto } from './documents/dto';
import { TaxReportsService } from './reports/tax-reports.service';
import { EtaxService } from '../pos/fiscal/etax.service';

// Scheduled tax automation jobs (docs/33 PR4, TAX-03/TAX-05). Idempotent action jobs the BI scheduler runs:
//  • tax_wht_cert_batch  — issue the 50-ทวิ certificate for every AP-payment WHT (labour/service withholding)
//    in a period that doesn't yet have one (closes the pndTieOut "un-certificated WHT" gap).
//  • tax_pp30_draft / tax_pnd_draft — register the period's PP30 / PND filing as a DRAFT (a human submits).
//  • tax_remittance_reminder — the period's remittance summary (amounts due + deadlines) for a nudge.
//  • etax_submission_retry — retry every e-Tax submission stuck at a non-Accepted status (gap #5, submission
//    durability): EtaxService.submit() now records every attempt (success/reject/thrown error), this just
//    re-runs submit() for the latest failed row per doc_no.
// All are read-mostly and safe to re-run: the cert batch skips already-certificated payments; fileReturn is
// idempotent per (tenant, type, period); the e-Tax retry only touches docs not yet Accepted.
@Injectable()
export class TaxJobsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly wht: WhtService,
    private readonly reports: TaxReportsService,
    private readonly etax: EtaxService,
  ) {}

  private win(month?: number, year?: number) {
    const now = ymd();
    const y = year ?? Number(now.slice(0, 4));
    const m = month ?? Number(now.slice(5, 7));
    const p2 = (x: number) => String(x).padStart(2, '0');
    const start = `${y}-${p2(m)}-01`;
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const end = `${ny}-${p2(nm)}-01`;
    return { start, end, month: m, year: y, period: `${y}-${p2(m)}` };
  }

  // ── tax_wht_cert_batch: auto-issue the 50-ทวิ for each un-certificated AP-payment WHT in the period ──
  async runWhtCertBatch(user: JwtUser, month?: number, year?: number) {
    const db = this.db;
    const { start, end, period } = this.win(month, year);
    // Approved AP payments that withheld tax in the period, with the vendor for the payee snapshot.
    const rows = await db.select({
      paymentNo: apPayments.paymentNo, txnNo: apPayments.txnNo, approvedAt: apPayments.approvedAt,
      whtIncomeType: apPayments.whtIncomeType, whtRate: apPayments.whtRate, whtAmount: apPayments.whtAmount,
      vendorId: apTransactions.vendorId, vendorName: apTransactions.vendorName,
    }).from(apPayments).innerJoin(apTransactions, eq(apPayments.txnNo, apTransactions.txnNo))
      .where(and(
        eq(apPayments.status, 'Approved'),
        sql`${apPayments.whtAmount} > 0`,
        sql`${apPayments.approvedAt} >= ${start} AND ${apPayments.approvedAt} < ${end}`,
      ));
    if (!rows.length) return { scanned: 0, issued: 0, skipped: 0, period };

    // Payments already certificated (idempotency): a 50-ทวิ linked by payment_no.
    const payNos = rows.map(r => r.paymentNo).filter((x): x is string => !!x);
    const existing = payNos.length
      ? await db.select({ p: whtCertificates.paymentNo }).from(whtCertificates).where(inArray(whtCertificates.paymentNo, payNos))
      : [];
    const certificated = new Set(existing.map(e => e.p));

    let issued = 0, skipped = 0;
    for (const r of rows) {
      if (!r.paymentNo || certificated.has(r.paymentNo)) { if (r.paymentNo && certificated.has(r.paymentNo)) skipped++; continue; }
      const rate = n(r.whtRate);
      if (!(rate > 0) || !r.whtIncomeType || r.vendorId == null) { skipped++; continue; }
      // Resolve the payee (vendor) — taxId is decrypted by the encryptedText column type.
      const [v] = await db.select().from(vendors).where(eq(vendors.id, r.vendorId)).limit(1);
      if (!v?.taxId) { skipped++; continue; }
      const base = Math.round((n(r.whtAmount) / rate) * 100) / 100; // pre-VAT income base the WHT was taken on
      const datePaid = (r.approvedAt instanceof Date ? r.approvedAt.toISOString() : String(r.approvedAt)).slice(0, 10);
      const dto: IssueWhtDto = {
        date_paid: datePaid,
        payee: { name: v.name ?? r.vendorName ?? '', tax_id: String(v.taxId), address: v.address ?? undefined, kind: 'company' },
        lines: [{ income_type: r.whtIncomeType, amount_paid: base, rate, description: `หัก ณ ที่จ่าย ตามการจ่ายเงิน ${r.paymentNo} (${r.txnNo})` }],
        ap_txn_no: r.txnNo, payment_no: r.paymentNo,
      };
      try {
        await this.wht.issue(dto, user);
        issued++;
      } catch {
        // Invalid payee/payer tax id, unknown income type, disallowed rate — skip this one, keep going.
        skipped++;
      }
    }
    return { scanned: rows.length, issued, skipped, period };
  }

  // ── tax_pp30_draft / tax_pnd_draft: register the period filing as a DRAFT (idempotent) ──
  async runFilingDraft(user: JwtUser, type: string, month?: number, year?: number) {
    const { month: m, year: y, period } = this.win(month, year);
    const filing = await this.reports.fileReturn(type, m, y, user);
    return { ...filing, period };
  }

  // ── tax_remittance_reminder: the period's remittance summary (amounts due + deadlines) ──
  async remittanceReminder(_user: JwtUser, month?: number, year?: number) {
    const { month: m, year: y, period } = this.win(month, year);
    const [pp30, tie] = await Promise.all([this.reports.pp30(m, y), this.reports.pndTieOut(m, y)]);
    return {
      period,
      pp30: { net_vat_payable: round2(pp30.form.vat_payable), deadline: pp30.deadline },
      pnd: { wht_withheld: tie.ap_wht_withheld, uncertificated_wht: tie.uncertificated_wht, deadline: tie.deadline },
    };
  }

  // ── etax_submission_retry: retry every e-Tax submission whose latest attempt isn't Accepted yet ──
  async runEtaxSubmissionRetry(user: JwtUser, limit?: number) {
    return this.etax.retryFailed(user, limit);
  }
}

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

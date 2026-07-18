import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { eq, and, ne, asc, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { apPaymentRuns, apPaymentRunLines, bankAccounts, vendors, tenants } from '../../database/schema';
import { StatusLogService } from '../../common/status-log.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

type PaymentRunRow = typeof apPaymentRuns.$inferSelect;

// Thai bank bulk-transfer file generation for an approved AP payment run (FIN-2, control EXP-13) —
// extracted off ApPaymentRunService (600-LOC service-size headroom round; ctor-body plain class, no DI).
// The run lifecycle (propose/approve/execute) stays on the facade; this class owns only the file surface:
// format presets, beneficiary fail-closed validation, SHA-256 pinning + status-log evidence.
export class ApPaymentRunFileService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly statusLog: StatusLogService,
    // Facade-ctor closure (procurement-facade pattern): the canonical run loader stays on the facade.
    private readonly loadRun: (runNo: string) => Promise<PaymentRunRow>,
  ) {}

  // ── Thai bank bulk-transfer file (generic CSV + named presets) / minimal ISO 20022 pain.001 XML.
  // The layouts are DOCUMENTED, CONFIGURABLE presets (see PN-02 §7(8b)) — column orders for scb/kbank/bbl
  // follow the common Thai cash-management bulk-upload shape (header/detail/trailer records) and are meant
  // to be adjusted to the bank's current template before go-live. The file's SHA-256 is pinned on the run
  // and status-logged so the file handed to the bank is provably the file the run generated (EXP-13). ──
  async bankFile(runNo: string, format: string | undefined, user: JwtUser): Promise<{ filename: string; contentType: string; body: string; sha256: string }> {
    const db = this.db;
    const run = await this.loadRun(runNo);
    // Use the run's canonical, DB-sourced run_no (APRUN-YYYYMMDD-NNN) everywhere below — never the raw
    // path param — so no request-controlled value is reflected into the filename/headers or the file body.
    const canonicalRunNo = run.runNo;
    if (run.status !== 'Approved' && run.status !== 'Executed') {
      throw new BadRequestException({ code: 'RUN_NOT_APPROVED', message: `Bank file is available only for an approved/executed run (run is ${run.status})`, messageTh: 'สร้างไฟล์ธนาคารได้เฉพาะรอบจ่ายที่อนุมัติแล้ว' });
    }
    const fmt = (format ?? 'generic').toLowerCase();
    if (!['generic', 'scb', 'kbank', 'bbl', 'iso20022'].includes(fmt)) {
      throw new BadRequestException({ code: 'UNSUPPORTED_FILE_FORMAT', message: `Unsupported bank-file format '${format}'`, messageTh: 'ไม่รองรับรูปแบบไฟล์นี้ (generic | scb | kbank | bbl | iso20022)' });
    }
    const [bank] = run.bankAccountId != null ? await db.select().from(bankAccounts).where(eq(bankAccounts.id, Number(run.bankAccountId))).limit(1) : [null];
    const [payer] = run.tenantId != null ? await db.select().from(tenants).where(eq(tenants.id, Number(run.tenantId))).limit(1) : [null];
    const lines = await db.select().from(apPaymentRunLines).where(and(eq(apPaymentRunLines.runId, Number(run.id)), ne(apPaymentRunLines.status, 'Failed'))).orderBy(asc(apPaymentRunLines.id));
    if (!lines.length) throw new BadRequestException({ code: 'EMPTY_RUN', message: 'Run has no payable lines', messageTh: 'รอบจ่ายไม่มีรายการที่จ่ายได้' });

    // Beneficiary bank details come from the vendor master at the payment boundary (encrypted at rest,
    // ITGC-AC-19). FAIL CLOSED on a missing account: a bulk file with blank beneficiaries is a mispay risk.
    const vendorIds = [...new Set(lines.map((l) => l.vendorId).filter((v): v is number => v != null).map(Number))];
    const vrows = vendorIds.length ? await db.select().from(vendors).where(inArray(vendors.id, vendorIds)) : [];
    const vmap = new Map<number, typeof vendors.$inferSelect>(vrows.map((v) => [Number(v.id), v]));
    const missing: string[] = [];
    const details = lines.map((l, i) => {
      const v = l.vendorId != null ? vmap.get(Number(l.vendorId)) : undefined;
      const acct = (v?.bankAccount ?? '').replace(/[^0-9]/g, '');
      const bankName = v?.bankName ?? '';
      if (!acct) missing.push(`${l.txnNo} (${l.vendorName ?? v?.name ?? 'vendor ' + (l.vendorId ?? '?')})`);
      return {
        seq: i + 1, beneficiary_bank: bankName, beneficiary_account: acct,
        beneficiary_name: v?.name ?? l.vendorName ?? '', amount: n(l.netAmount ?? l.amount),
        ref: l.txnNo, wht: n(l.whtAmount),
      };
    });
    if (missing.length) {
      throw new BadRequestException({ code: 'VENDOR_BANK_MISSING', message: `Vendor bank account missing for: ${missing.join(', ')} — record the beneficiary account on the vendor master (bank-detail changes are maker-checked, EXP-11)`, messageTh: 'ไม่มีเลขบัญชีธนาคารของผู้ขาย — บันทึกในทะเบียนผู้ขายก่อนสร้างไฟล์' });
    }
    const total = round2(details.reduce((a, d) => a + d.amount, 0));
    const payDate = String(run.payDate ?? ymd());
    const debitAcct = (bank?.accountNo ?? '').replace(/[^0-9]/g, '');

    let body: string; let contentType = 'text/csv; charset=utf-8'; let ext = 'csv';
    if (fmt === 'iso20022') {
      body = pain001Xml({ runNo: canonicalRunNo, payDate, debitAcct, debitName: payer?.legalName ?? payer?.name ?? '', details, total });
      contentType = 'application/xml; charset=utf-8'; ext = 'xml';
    } else {
      body = thaiBulkCsv(fmt, { runNo: canonicalRunNo, payDate, debitAcct, debitBank: bank?.bankName ?? '', debitName: payer?.legalName ?? payer?.name ?? '', details, total });
    }
    const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
    await db.update(apPaymentRuns).set({ fileFormat: fmt, fileHash: sha256, fileGeneratedAt: new Date() }).where(eq(apPaymentRuns.id, Number(run.id)));
    // Audit event — the hash of the exact bytes handed to the bank (EXP-13 evidence; GETs skip the
    // mutating-request audit interceptor, so the status log carries it).
    await this.statusLog.log('APRUN', canonicalRunNo, String(run.status), String(run.status), user.username, `bank-file ${fmt} sha256=${sha256}`);
    return { filename: `${canonicalRunNo}-${fmt}.${ext}`, contentType, body, sha256 };
  }
}

interface FileDetail { seq: number; beneficiary_bank: string; beneficiary_account: string; beneficiary_name: string; amount: number; ref: string; wht: number }
interface FileCtx { runNo: string; payDate: string; debitAcct: string; debitBank?: string; debitName: string; details: FileDetail[]; total: number }

// Generic Thai bulk-transfer CSV: one H(eader), N D(etail) rows, one T(railer). The named presets reorder
// the detail columns to each bank's common bulk-upload shape; adjust to the bank's current template at
// go-live (documented as configurable in PN-02 §7(8b)). Amounts are plain 2-dp decimals; CSV fields are
// quoted only when they contain a comma/quote.
function thaiBulkCsv(preset: string, ctx: FileCtx): string {
  const q = (s: string | number) => { const v = String(s); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const amt = (x: number) => x.toFixed(2);
  const rows: string[] = [];
  rows.push(['H', ctx.runNo, ctx.payDate, ctx.debitAcct, String(ctx.details.length), amt(ctx.total)].map(q).join(','));
  for (const d of ctx.details) {
    let cols: (string | number)[];
    switch (preset) {
      case 'scb':   // SCB Business Net bulk shape: seq, receiving bank, receiving acct, name, amount, value date, reference
        cols = ['D', d.seq, d.beneficiary_bank, d.beneficiary_account, d.beneficiary_name, amt(d.amount), ctx.payDate, d.ref]; break;
      case 'kbank': // K-Cash Connect bulk shape: seq, receiving acct, name, bank, amount, reference, value date
        cols = ['D', d.seq, d.beneficiary_account, d.beneficiary_name, d.beneficiary_bank, amt(d.amount), d.ref, ctx.payDate]; break;
      case 'bbl':   // Bualuang iBanking bulk shape: seq, bank, acct, amount, name, reference
        cols = ['D', d.seq, d.beneficiary_bank, d.beneficiary_account, amt(d.amount), d.beneficiary_name, d.ref]; break;
      default:      // generic
        cols = ['D', d.seq, d.beneficiary_bank, d.beneficiary_account, d.beneficiary_name, amt(d.amount), d.ref, amt(d.wht)]; break;
    }
    rows.push(cols.map(q).join(','));
  }
  rows.push(['T', String(ctx.details.length), amt(ctx.total)].map(q).join(','));
  return rows.join('\r\n') + '\r\n';
}

// Minimal, well-formed ISO 20022 pain.001.001.03 (CustomerCreditTransferInitiation) — one payment info
// block, one credit transfer per run line. THB, Asia/Bangkok business dating.
function pain001Xml(ctx: { runNo: string; payDate: string; debitAcct: string; debitName: string; details: FileDetail[]; total: number }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const txs = ctx.details.map((d) => `      <CdtTrfTxInf>
        <PmtId><EndToEndId>${esc(d.ref)}</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="THB">${d.amount.toFixed(2)}</InstdAmt></Amt>
        <Cdtr><Nm>${esc(d.beneficiary_name)}</Nm></Cdtr>
        <CdtrAcct><Id><Othr><Id>${esc(d.beneficiary_account)}</Id></Othr></Id></CdtrAcct>
        <RmtInf><Ustrd>${esc(d.ref)}</Ustrd></RmtInf>
      </CdtTrfTxInf>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${esc(ctx.runNo)}</MsgId>
      <CreDtTm>${new Date().toISOString()}</CreDtTm>
      <NbOfTxs>${ctx.details.length}</NbOfTxs>
      <CtrlSum>${ctx.total.toFixed(2)}</CtrlSum>
      <InitgPty><Nm>${esc(ctx.debitName)}</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${esc(ctx.runNo)}</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <ReqdExctnDt>${esc(ctx.payDate)}</ReqdExctnDt>
      <Dbtr><Nm>${esc(ctx.debitName)}</Nm></Dbtr>
      <DbtrAcct><Id><Othr><Id>${esc(ctx.debitAcct)}</Id></Othr></Id></DbtrAcct>
${txs}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;
}

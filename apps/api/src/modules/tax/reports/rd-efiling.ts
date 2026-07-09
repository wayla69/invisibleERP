// RD e-Filing attachment formatters (pure — no DB, unit-testable).
//
// 1. ภ.ง.ด.3/53 ใบแนบ transfer file: the pipe-delimited text layout of the RD "โปรแกรมโอนย้ายข้อมูล
//    แบบยื่นรายการภาษีหัก ณ ที่จ่าย" (one row per certificate line):
//      ลำดับ|เลขประจำตัวผู้เสียภาษี(13)|สาขาที่(5)|ชื่อผู้ถูกหัก|ที่อยู่|วันที่จ่าย(ววดดปปปป พ.ศ.)|
//      ประเภทเงินได้|อัตราภาษี|จำนวนเงินที่จ่าย|ภาษีที่หัก|เงื่อนไข(1/2/3)
//    Encoding: the RD transfer program reads TIS-620 (single-byte Thai); `tis620()` transcodes.
//    NB — the RD revises this program periodically: verify the column mapping against the current RD
//    spec (and file one test month) before the first live filing. The layout is standard practice but
//    the RD does not publish a stable versioned schema.
// 2. รายงานภาษีซื้อ/ภาษีขาย + ภ.พ.30 summary as CSV (UTF-8 BOM so Thai opens correctly in Excel) —
//    the working-paper attachments an accountant files alongside the online ภ.พ.30 form.

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const money = (x: number) => round2(x).toFixed(2);

/** ISO YYYY-MM-DD → RD date ววดดปปปป (Buddhist Era, DDMMYYYY). Invalid input → ''. */
export function rdDateBE(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  if (!m) return '';
  return `${m[3]}${m[2]}${Number(m[1]) + 543}`;
}

/** WHT condition → RD เงื่อนไข code: 1 หักณที่จ่าย · 2 ออกภาษีให้ตลอดไป · 3 ออกให้ครั้งเดียว. */
export function rdWhtCondition(condition: string | null | undefined): '1' | '2' | '3' {
  if (condition === 'absorb_always') return '2';
  if (condition === 'absorb_once') return '3';
  return '1'; // withhold / other / unspecified → standard withholding
}

/** UTF-8 string → TIS-620 bytes (ASCII passthrough, Thai U+0E01–U+0E5B → 0xA1–0xFB, else '?'). */
export function tis620(text: string): Buffer {
  const out = Buffer.alloc(text.length, 0x3f);
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    if (cp < 0x80) out[i] = cp;
    else if (cp >= 0x0e01 && cp <= 0x0e5b) out[i] = cp - 0x0e01 + 0xa1;
    // else keep '?' — TIS-620 has no mapping (emoji, non-Thai scripts)
  }
  return out;
}

export interface PndEfilingRow {
  payee_tax_id: string | null;
  payee_branch_code: string | null;
  payee_name: string | null;
  payee_address: string | null;
  date_paid: string | null;
  income_type: string;
  description?: string | null; // Thai income-type label from the cert line (preferred over the code)
  rate: number; // FRACTION as stored (0.03) — emitted as ร้อยละ (3.00)
  amount_paid: number;
  tax_withheld: number;
  wht_condition: string | null;
}

/** ภ.ง.ด.3/53 ใบแนบ transfer-file body (pipe-delimited, CRLF rows — the RD program's reader). */
export function pndEfilingText(rows: PndEfilingRow[]): string {
  const clean = (s: string | null | undefined) => String(s ?? '').replace(/[|\r\n]/g, ' ').trim();
  return rows
    .map((r, i) => [
      String(i + 1),
      clean(r.payee_tax_id),
      clean(r.payee_branch_code) || '00000',
      clean(r.payee_name),
      clean(r.payee_address),
      rdDateBE(r.date_paid),
      clean(r.description || r.income_type),
      money(r.rate * 100), // stored as a fraction (0.03) → RD อัตราร้อยละ (3.00)
      money(r.amount_paid),
      money(r.tax_withheld),
      rdWhtCondition(r.wht_condition),
    ].join('|'))
    .join('\r\n');
}

// ── CSV working papers (UTF-8 BOM added by the caller when sending) ────────────────────────────────
const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csvOf = (headers: string[], rows: unknown[][]): string =>
  [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');

/** รายงานภาษีขาย (output VAT) CSV — columns per the RD sales-tax-report working paper. */
export function outputVatCsv(rep: { rows: any[]; totals: any; period: string }): string {
  return csvOf(
    ['ลำดับ', 'วันที่', 'เลขที่ใบกำกับภาษี', 'ประเภท', 'ชื่อผู้ซื้อ', 'เลขประจำตัวผู้เสียภาษีผู้ซื้อ', 'มูลค่าสินค้า/บริการ', 'ภาษีมูลค่าเพิ่ม'],
    [
      ...rep.rows.map((r, i) => [i + 1, r.date, r.doc_no, r.type, r.buyer_name, r.buyer_tax_id, money(r.value), money(r.vat)]),
      ['', '', '', '', `รวม (${rep.period})`, '', money(rep.totals.value), money(rep.totals.vat)],
    ],
  );
}

/** รายงานภาษีซื้อ (input VAT) CSV — flags estimated/no-tax-id rows so they are visibly not filable as-is. */
export function inputVatCsv(rep: { rows: any[]; totals: any; period: string }): string {
  return csvOf(
    ['ลำดับ', 'วันที่', 'เลขที่เอกสาร', 'เลขที่ใบกำกับ', 'ชื่อผู้ขาย', 'เลขประจำตัวผู้เสียภาษีผู้ขาย', 'มูลค่าฐาน', 'ภาษีมูลค่าเพิ่ม', 'หมายเหตุ'],
    [
      ...rep.rows.map((r, i) => [
        i + 1, r.date, r.doc_no, r.invoice_no, r.vendor_name, r.vendor_tax_id ?? 'ไม่มีเลขผู้เสียภาษี — ตรวจสอบก่อนยื่น',
        money(r.base), money(r.vat), r.vat_estimated ? 'VAT ประมาณการ — ห้ามยื่นก่อนตรวจ' : (r.vat_type === 'exempt_or_zero' ? 'ยกเว้น/อัตราศูนย์' : ''),
      ]),
      ['', '', '', '', `รวม (${rep.period})`, '', money(rep.totals.base), money(rep.totals.vat), rep.totals.missing_tax_id ? `แถวไม่มีเลขผู้เสียภาษี ${rep.totals.missing_tax_id}` : ''],
    ],
  );
}

/** ภ.พ.30 summary CSV — the form boxes + the GL tie-out line. */
export function pp30Csv(rep: { form: any; reconciliation: any; period: string; deadline: string }): string {
  const f = rep.form, rec = rep.reconciliation;
  return csvOf(
    ['รายการ', 'จำนวนเงิน'],
    [
      [`ยอดขายที่ต้องเสียภาษี (${rep.period})`, money(f.sales_taxable)],
      ['ภาษีขาย', money(f.output_vat)],
      ['ยอดซื้อ', money(f.purchases)],
      ['ภาษีซื้อ', money(f.input_vat)],
      ['ภาษีที่ต้องชำระ', money(f.vat_payable)],
      ['เครดิตภาษียกไป', money(f.vat_credit_carry_forward)],
      [`กระทบยอด GL (${rec.gl_account})`, money(rec.gl_net_movement)],
      ['กระทบยอดตรง', rec.tied ? 'ตรง' : 'ไม่ตรง — ตรวจสอบก่อนยื่น'],
      ['กำหนดยื่น', rep.deadline],
    ],
  );
}

import { Injectable } from '@nestjs/common';
import { bahtText } from '../../common/bahttext.util';
import { wrapA4, sellerHeaderHtml, esc, fmtMoney, thaiDate, formatTaxId, type DocParty } from '../../common/doc-html';
import { PdfRenderer } from '../pdf/pdf-renderer.service';

export interface SubcontractValuationPrintData {
  valuation_no: string;
  seq: number;
  period: string | null;
  status: string;
  certified_by: string | null;
  certified_at: unknown;
  seller: DocParty;           // the main contractor (our company) issuing the certificate
  subcontractor: DocParty;    // the subcontractor whose work is certified (the payee)
  project_code: string;
  project_name: string | null;
  subcontract_no: string;
  subcontract_title: string | null;
  contract_value: number;
  pct_complete: number;
  value_to_date: number;
  prev_certified: number;
  scope: { description: string | null; amount: number }[];
  gross: number;
  retention_pct: number;
  retention: number;
  back_charge: number;
  wht_pct: number;
  wht: number;
  vat_pct: number;
  vat: number;
  net_certified: number;
  ap_payable: number;
}

// HTML → PDF template for the ใบรับรองผลงานผู้รับเหมาช่วง (subcontract valuation certificate, docs/35 P2). It
// certifies the % complete of a subcontract, withholds retention payable, deducts back-charges and WHT, adds
// recoverable input VAT, and states the net payable to the subcontractor.
@Injectable()
export class SubcontractValuationPdfService {
  constructor(private readonly pdf: PdfRenderer) {}

  renderToPdf(html: string): Promise<Buffer | null> {
    return this.pdf.render(html, { format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  }

  valuationHtml(c: SubcontractValuationPrintData): string {
    const rows = c.scope.map((l, i) => `
      <tr><td class="c">${i + 1}</td><td>${esc(l.description ?? '')}</td><td class="r">${fmtMoney(l.amount)}</td></tr>`).join('');
    const words = `<div class="words">( ${esc(bahtText(c.ap_payable))} )</div>`;
    return wrapA4(`
      <div class="hdr">
        ${sellerHeaderHtml(c.seller)}
        <div class="ttl">ใบรับรองผลงานผู้รับเหมาช่วง<div class="sub">Subcontract Valuation Certificate</div><div class="stt">${esc(statusTh(c.status))}</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">ผู้รับเหมาช่วง</td><td>${esc(c.subcontractor.name)}</td><td class="lbl">เลขที่</td><td>${esc(c.valuation_no)}</td></tr>
        <tr><td class="lbl">เลขประจำตัวผู้เสียภาษี</td><td>${esc(c.subcontractor.tax_id ? formatTaxId(c.subcontractor.tax_id) : '-')}</td><td class="lbl">งวดที่</td><td>${esc(String(c.seq))}</td></tr>
        <tr><td class="lbl">โครงการ</td><td>${esc(c.project_name ?? c.project_code)} (${esc(c.project_code)})</td><td class="lbl">สัญญาผู้รับเหมาช่วง</td><td>${esc(c.subcontract_no)}</td></tr>
        <tr><td class="lbl">ความคืบหน้าสะสม</td><td>${c.pct_complete}% (${fmtMoney(c.value_to_date)})</td><td class="lbl">งวดบิล</td><td>${esc(c.period ?? '-')}</td></tr>
        <tr><td class="lbl">ผู้รับรอง</td><td>${esc(c.certified_by ?? '-')}</td><td class="lbl">วันที่รับรอง</td><td>${esc(thaiDate(c.certified_at))}</td></tr>
      </table>
      <table class="grid">
        <thead><tr><th class="c">ลำดับ</th><th>ขอบเขตงาน (BoQ)</th><th class="r">มูลค่าตามสัญญา</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="totals">
        <tr><td class="tlbl">มูลค่างานงวดนี้ (Gross)</td><td class="tval">${fmtMoney(c.gross)}</td></tr>
        <tr><td class="tlbl">หักเงินประกันผลงาน ${c.retention_pct}% (Retention)</td><td class="tval">-${fmtMoney(c.retention)}</td></tr>
        <tr><td class="tlbl">หักค่าปรับ/หักกลบ (Back-charge)</td><td class="tval">-${fmtMoney(c.back_charge)}</td></tr>
        <tr><td class="tlbl">คงเหลือสุทธิ (Net)</td><td class="tval">${fmtMoney(c.net_certified)}</td></tr>
        <tr><td class="tlbl">หักภาษี ณ ที่จ่าย ${c.wht_pct}% (WHT ภ.ง.ด.53)</td><td class="tval">-${fmtMoney(c.wht)}</td></tr>
        <tr><td class="tlbl">ภาษีมูลค่าเพิ่ม ${c.vat_pct}% (VAT)</td><td class="tval">${fmtMoney(c.vat)}</td></tr>
        <tr class="grand"><td class="tlbl">จำนวนเงินที่ต้องจ่าย (THB)</td><td class="tval">${fmtMoney(c.ap_payable)}</td></tr>
      </table>
      ${words}
      <div class="foot">
        <div class="sign">ผู้รับเหมาช่วง<div class="who"></div></div>
        <div class="sign">ผู้ตรวจรับรองผลงาน<div class="who"></div></div>
      </div>
    `, 'ใบรับรองผลงานผู้รับเหมาช่วง (Subcontract Valuation Certificate)');
  }
}

function statusTh(s: string): string {
  const m: Record<string, string> = { draft: 'ร่าง', certified: 'รับรองแล้ว', paid: 'ชำระแล้ว' };
  return m[s] ?? s;
}

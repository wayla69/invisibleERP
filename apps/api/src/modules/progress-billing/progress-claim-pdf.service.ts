import { Injectable } from '@nestjs/common';
import { bahtText } from '../../common/bahttext.util';
import { wrapA4, sellerHeaderHtml, esc, fmtMoney, thaiDate, formatTaxId, type DocParty } from '../../common/doc-html';
import { PdfRenderer } from '../pdf/pdf-renderer.service';

export interface ProgressClaimPrintData {
  claim_no: string;
  seq: number;
  period: string | null;
  status: string;
  certified_by: string | null;
  certified_at: unknown;
  seller: DocParty;
  customer: DocParty;
  project_code: string;
  project_name: string | null;
  lines: { description: string | null; pct: number; value_to_date: number; previously_certified: number; value_this_claim: number }[];
  gross: number;
  retention_pct: number;
  retention: number;
  net: number;
  vat_pct: number;
  vat: number;
  ar_total: number;
}

// HTML → PDF template for the ใบวางบิลงวดงาน / ใบกำกับภาษี (construction progress-claim tax invoice, docs/35 P1).
// Values work by BoQ line (cumulative), withholds retention, adds output VAT, and states the net billed.
@Injectable()
export class ProgressClaimPdfService {
  constructor(private readonly pdf: PdfRenderer) {}

  renderToPdf(html: string): Promise<Buffer | null> {
    return this.pdf.render(html, { format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  }

  claimHtml(c: ProgressClaimPrintData): string {
    const rows = c.lines.map((l, i) => `
      <tr><td class="c">${i + 1}</td><td>${esc(l.description ?? '')}</td>
      <td class="r">${l.pct}%</td><td class="r">${fmtMoney(l.value_to_date)}</td>
      <td class="r">${fmtMoney(l.previously_certified)}</td><td class="r">${fmtMoney(l.value_this_claim)}</td></tr>`).join('');
    const words = `<div class="words">( ${esc(bahtText(c.ar_total))} )</div>`;
    return wrapA4(`
      <div class="hdr">
        ${sellerHeaderHtml(c.seller)}
        <div class="ttl">ใบวางบิลงวดงาน / ใบกำกับภาษี<div class="sub">Progress Claim / Tax Invoice</div><div class="stt">${esc(statusTh(c.status))}</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">ลูกค้า / ผู้ว่าจ้าง</td><td>${esc(c.customer.name)}</td><td class="lbl">เลขที่</td><td>${esc(c.claim_no)}</td></tr>
        <tr><td class="lbl">เลขประจำตัวผู้เสียภาษี</td><td>${esc(c.customer.tax_id ? formatTaxId(c.customer.tax_id) : '-')}</td><td class="lbl">งวดที่</td><td>${esc(String(c.seq))}</td></tr>
        <tr><td class="lbl">โครงการ</td><td>${esc(c.project_name ?? c.project_code)} (${esc(c.project_code)})</td><td class="lbl">งวดบิล</td><td>${esc(c.period ?? '-')}</td></tr>
        <tr><td class="lbl">ผู้รับรอง</td><td>${esc(c.certified_by ?? '-')}</td><td class="lbl">วันที่รับรอง</td><td>${esc(thaiDate(c.certified_at))}</td></tr>
      </table>
      <table class="grid">
        <thead><tr><th class="c">ลำดับ</th><th>รายการงาน (BoQ)</th><th class="r">% สะสม</th><th class="r">มูลค่าสะสม</th><th class="r">งวดก่อน</th><th class="r">งวดนี้</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="totals">
        <tr><td class="tlbl">มูลค่างานงวดนี้ (Gross)</td><td class="tval">${fmtMoney(c.gross)}</td></tr>
        <tr><td class="tlbl">หักเงินประกันผลงาน ${c.retention_pct}% (Retention)</td><td class="tval">-${fmtMoney(c.retention)}</td></tr>
        <tr><td class="tlbl">คงเหลือ (Net)</td><td class="tval">${fmtMoney(c.net)}</td></tr>
        <tr><td class="tlbl">ภาษีมูลค่าเพิ่ม ${c.vat_pct}% (VAT)</td><td class="tval">${fmtMoney(c.vat)}</td></tr>
        <tr class="grand"><td class="tlbl">จำนวนเงินที่เรียกเก็บ (THB)</td><td class="tval">${fmtMoney(c.ar_total)}</td></tr>
      </table>
      ${words}
      <div class="foot">
        <div class="sign">ผู้วางบิล<div class="who"></div></div>
        <div class="sign">ผู้ตรวจรับงาน (ผู้ว่าจ้าง)<div class="who"></div></div>
      </div>
    `, 'ใบวางบิลงวดงาน (Progress Claim / Tax Invoice)');
  }
}

function statusTh(s: string): string {
  const m: Record<string, string> = { draft: 'ร่าง', certified: 'รับรองแล้ว', invoiced: 'วางบิลแล้ว', paid: 'ชำระแล้ว' };
  return m[s] ?? s;
}

import { Injectable } from '@nestjs/common';
import { wrapA4, sellerHeaderHtml, esc, fmtQty, thaiDate, type DocParty } from '../../common/doc-html';
import { PdfRenderer } from '../pdf/pdf-renderer.service';

export interface RfqPrintData {
  rfq_no: string; rfq_date: string | null; required_date: string | null; status: string;
  remarks: string | null; created_by: string | null;
  seller: DocParty;   // our company (the buyer requesting quotes)
  vendor_name: string | null; // addressed supplier, if any
  lines: { item_id: string | null; description: string | null; qty: number; uom: string | null }[];
}

// HTML → PDF template for the ใบขอเสนอราคา (Request for Quotation) sent to suppliers. Lists the items to be
// quoted and the required-by date. Same shared shell + PdfRenderer (HTML fallback when Chromium absent).
@Injectable()
export class RfqPdfService {
  constructor(private readonly pdf: PdfRenderer) {}

  renderToPdf(html: string): Promise<Buffer | null> {
    return this.pdf.render(html, { format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  }

  rfqHtml(r: RfqPrintData): string {
    const rows = r.lines.map((l, i) => `
      <tr><td class="c">${i + 1}</td><td>${esc(l.item_id ?? '')}</td><td>${esc(l.description ?? '')}</td>
      <td class="r">${fmtQty(l.qty)}</td><td class="c">${esc(l.uom ?? '')}</td><td></td></tr>`).join('');
    return wrapA4(`
      <div class="hdr">
        ${sellerHeaderHtml(r.seller)}
        <div class="ttl">ใบขอเสนอราคา<div class="sub">Request for Quotation</div><div class="stt">${esc(statusTh(r.status))}</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">เรียน (ผู้ขาย)</td><td>${esc(r.vendor_name ?? 'ผู้ขายที่สนใจเสนอราคา')}</td><td class="lbl">เลขที่</td><td>${esc(r.rfq_no)}</td></tr>
        <tr><td class="lbl">ต้องการภายใน</td><td>${esc(thaiDate(r.required_date))}</td><td class="lbl">วันที่</td><td>${esc(thaiDate(r.rfq_date))}</td></tr>
      </table>
      <div class="rmk" style="margin:8px 0">บริษัทมีความประสงค์ขอเชิญท่านเสนอราคาสำหรับรายการต่อไปนี้ กรุณาระบุราคา/หน่วยและกำหนดส่งมอบในช่องว่าง แล้วส่งกลับภายในวันที่กำหนด</div>
      <table class="grid">
        <thead><tr><th class="c">ลำดับ</th><th>รหัสสินค้า</th><th>รายการ</th><th class="r">จำนวน</th><th class="c">หน่วย</th><th class="r">ราคาเสนอ/หน่วย</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${r.remarks ? `<div class="rmk"><span class="b">หมายเหตุ:</span> ${esc(r.remarks)}</div>` : ''}
      <div class="foot">
        <div class="sign">ผู้ขอเสนอราคา<div class="who">${esc(r.created_by ?? '')}</div></div>
        <div class="sign">ผู้เสนอราคา (ผู้ขาย)<div class="who"></div></div>
      </div>
    `, 'ใบขอเสนอราคา (RFQ)');
  }
}

function statusTh(s: string): string {
  const m: Record<string, string> = { Open: 'เปิดรับราคา', Awarded: 'มอบงานแล้ว', Cancelled: 'ยกเลิก' };
  return m[s] ?? s;
}

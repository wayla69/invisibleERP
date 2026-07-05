import { Injectable } from '@nestjs/common';
import { wrapA4, sellerHeaderHtml, esc, fmtQty, thaiDate, type DocParty } from '../../common/doc-html';
import { PdfRenderer } from '../pdf/pdf-renderer.service';

export interface DeliveryPrintData {
  do_no: string;
  do_date: string | null;
  status: string;
  address: string | null;   // ship-to
  driver: string | null;
  vehicle: string | null;
  remarks: string | null;
  created_by: string | null;
  order_no: string | null;
  seller: DocParty;
  lines: { item_id: string | null; description: string | null; qty: number; uom: string | null }[];
}

// HTML → PDF template for the ใบส่งของ / ใบส่งสินค้า (Delivery Note / packing slip). A goods-movement
// document (no prices) — item lines, ship-to, driver/vehicle, and receiver signature. Same shell + shared
// PdfRenderer (HTML fallback when Chromium absent) as the other documents.
@Injectable()
export class DeliveryPdfService {
  constructor(private readonly pdf: PdfRenderer) {}

  renderToPdf(html: string): Promise<Buffer | null> {
    return this.pdf.render(html, { format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  }

  deliveryNoteHtml(d: DeliveryPrintData): string {
    const rows = d.lines.map((l, i) => `
      <tr><td class="c">${i + 1}</td><td>${esc(l.item_id ?? '')}</td><td>${esc(l.description ?? '')}</td>
      <td class="r">${fmtQty(l.qty)}</td><td class="c">${esc(l.uom ?? '')}</td></tr>`).join('');
    return wrapA4(`
      <div class="hdr">
        ${sellerHeaderHtml(d.seller)}
        <div class="ttl">ใบส่งของ<div class="sub">Delivery Note</div><div class="stt">${esc(statusTh(d.status))}</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">ส่งถึง (ที่อยู่จัดส่ง)</td><td>${esc(d.address ?? '-')}</td><td class="lbl">เลขที่</td><td>${esc(d.do_no)}</td></tr>
        <tr><td class="lbl">อ้างอิงใบสั่งขาย</td><td>${esc(d.order_no ?? '-')}</td><td class="lbl">วันที่</td><td>${esc(thaiDate(d.do_date))}</td></tr>
        <tr><td class="lbl">พนักงานขับรถ</td><td>${esc(d.driver ?? '-')}</td><td class="lbl">ทะเบียนรถ</td><td>${esc(d.vehicle ?? '-')}</td></tr>
      </table>
      <table class="grid">
        <thead><tr><th class="c">ลำดับ</th><th>รหัสสินค้า</th><th>รายการ</th><th class="r">จำนวน</th><th class="c">หน่วย</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${d.remarks ? `<div class="rmk"><span class="b">หมายเหตุ:</span> ${esc(d.remarks)}</div>` : ''}
      <div class="foot">
        <div class="sign">ผู้ส่งสินค้า<div class="who">${esc(d.created_by ?? '')}</div></div>
        <div class="sign">ผู้รับสินค้า (ลูกค้า)<div class="who"></div></div>
      </div>
    `, 'ใบส่งของ (Delivery Note)');
  }
}

function statusTh(s: string): string {
  const m: Record<string, string> = { Pending: 'รอจัดส่ง', 'In Transit': 'กำลังจัดส่ง', Delivered: 'ส่งแล้ว', Cancelled: 'ยกเลิก' };
  return m[s] ?? s;
}

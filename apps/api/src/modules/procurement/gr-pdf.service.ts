import { Injectable } from '@nestjs/common';
import { wrapA4, sellerHeaderHtml, esc, fmtQty, fmtMoney, thaiDate, formatTaxId, type DocParty } from '../../common/doc-html';
import { PdfRenderer } from '../pdf/pdf-renderer.service';

export interface GrPrintData {
  gr_no: string; gr_date: string | null; po_no: string | null; remarks: string | null;
  received_by: string | null; currency: string;
  seller: DocParty;   // our company (receiver)
  vendor: DocParty;   // supplier who delivered
  lines: { item_id: string | null; description: string | null; received_qty: number; uom: string | null; unit_cost: number; lot_no: string | null }[];
}

// HTML → PDF template for the ใบรับสินค้า (Goods Receipt Note). Records what was received against a PO —
// item, quantity, lot; carries a receiver signature. Same shared shell + PdfRenderer (HTML fallback).
@Injectable()
export class GrPdfService {
  constructor(private readonly pdf: PdfRenderer) {}

  renderToPdf(html: string): Promise<Buffer | null> {
    return this.pdf.render(html, { format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  }

  goodsReceiptHtml(g: GrPrintData): string {
    const showCost = g.lines.some((l) => l.unit_cost > 0);
    const rows = g.lines.map((l, i) => `
      <tr><td class="c">${i + 1}</td><td>${esc(l.item_id ?? '')}</td><td>${esc(l.description ?? '')}</td>
      <td class="r">${fmtQty(l.received_qty)}</td><td class="c">${esc(l.uom ?? '')}</td><td>${esc(l.lot_no ?? '')}</td>
      ${showCost ? `<td class="r">${fmtMoney(l.unit_cost)}</td>` : ''}</tr>`).join('');
    return wrapA4(`
      <div class="hdr">
        ${sellerHeaderHtml(g.seller)}
        <div class="ttl">ใบรับสินค้า<div class="sub">Goods Receipt Note</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">ผู้ส่งมอบ (ผู้ขาย)</td><td>${esc(g.vendor.name)}</td><td class="lbl">เลขที่</td><td>${esc(g.gr_no)}</td></tr>
        <tr><td class="lbl">เลขประจำตัวผู้เสียภาษีผู้ขาย</td><td>${esc(g.vendor.tax_id ? formatTaxId(g.vendor.tax_id) : '-')}</td><td class="lbl">วันที่รับ</td><td>${esc(thaiDate(g.gr_date))}</td></tr>
        <tr><td class="lbl">อ้างอิงใบสั่งซื้อ</td><td>${esc(g.po_no ?? '-')}</td><td class="lbl">ผู้รับสินค้า</td><td>${esc(g.received_by ?? '-')}</td></tr>
      </table>
      <table class="grid">
        <thead><tr><th class="c">ลำดับ</th><th>รหัสสินค้า</th><th>รายการ</th><th class="r">จำนวนรับ</th><th class="c">หน่วย</th><th>ล็อต</th>${showCost ? '<th class="r">ราคา/หน่วย</th>' : ''}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${g.remarks ? `<div class="rmk"><span class="b">หมายเหตุ:</span> ${esc(g.remarks)}</div>` : ''}
      <div class="foot">
        <div class="sign">ผู้ส่งมอบ (ผู้ขาย)<div class="who"></div></div>
        <div class="sign">ผู้รับสินค้า<div class="who">${esc(g.received_by ?? '')}</div></div>
      </div>
    `, 'ใบรับสินค้า (Goods Receipt)');
  }
}

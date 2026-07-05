import { Injectable } from '@nestjs/common';
import { bahtText } from '../../common/bahttext.util';
import { wrapA4, sellerHeaderHtml, esc, fmtMoney, fmtQty, thaiDate, formatTaxId, type DocParty } from '../../common/doc-html';
import { PdfRenderer } from '../pdf/pdf-renderer.service';

export interface ArInvoicePrintData {
  invoice_no: string;
  invoice_date: string | null;
  due_date: string | null;
  status: string;
  currency: string;
  order_no: string | null;
  seller: DocParty;
  customer: DocParty;
  lines: { description: string | null; qty: number; unit_price: number; amount: number }[];
  subtotal: number;   // Σ line amounts
  amount: number;     // invoice total (billed)
  paid_amount: number;
  balance: number;    // amount − paid
}

// HTML → PDF template for the ใบแจ้งหนี้ / ใบวางบิล (AR billing invoice — distinct from the statutory
// ใบกำกับภาษี). States the amount billed, paid, and outstanding for the customer. Shared shell + PdfRenderer
// (HTML fallback when Chromium absent).
@Injectable()
export class ArInvoicePdfService {
  constructor(private readonly pdf: PdfRenderer) {}

  renderToPdf(html: string): Promise<Buffer | null> {
    return this.pdf.render(html, { format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  }

  arInvoiceHtml(inv: ArInvoicePrintData): string {
    const rows = inv.lines.map((l, i) => `
      <tr><td class="c">${i + 1}</td><td>${esc(l.description ?? '')}</td>
      <td class="r">${fmtQty(l.qty)}</td><td class="r">${fmtMoney(l.unit_price)}</td><td class="r">${fmtMoney(l.amount)}</td></tr>`).join('');
    const ccy = esc(inv.currency || 'THB');
    const words = inv.currency === 'THB' ? `<div class="words">( ${esc(bahtText(inv.amount))} )</div>` : '';
    const paidRow = inv.paid_amount > 0
      ? `<tr><td class="tlbl">ชำระแล้ว</td><td class="tval">-${fmtMoney(inv.paid_amount)}</td></tr>
         <tr class="grand"><td class="tlbl">คงเหลือค้างชำระ (${ccy})</td><td class="tval">${fmtMoney(inv.balance)}</td></tr>`
      : `<tr class="grand"><td class="tlbl">จำนวนเงินรวมทั้งสิ้น (${ccy})</td><td class="tval">${fmtMoney(inv.amount)}</td></tr>`;
    return wrapA4(`
      <div class="hdr">
        ${sellerHeaderHtml(inv.seller)}
        <div class="ttl">ใบแจ้งหนี้/ใบวางบิล<div class="sub">Invoice / Billing Note</div><div class="stt">${esc(statusTh(inv.status))}</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">ลูกค้า</td><td>${esc(inv.customer.name)}</td><td class="lbl">เลขที่</td><td>${esc(inv.invoice_no)}</td></tr>
        <tr><td class="lbl">ที่อยู่</td><td>${esc(inv.customer.address ?? '-')}</td><td class="lbl">วันที่</td><td>${esc(thaiDate(inv.invoice_date))}</td></tr>
        <tr><td class="lbl">เลขประจำตัวผู้เสียภาษี</td><td>${esc(inv.customer.tax_id ? formatTaxId(inv.customer.tax_id) : '-')}</td><td class="lbl">ครบกำหนดชำระ</td><td>${esc(thaiDate(inv.due_date))}</td></tr>
        <tr><td class="lbl">อ้างอิงใบสั่งขาย</td><td>${esc(inv.order_no ?? '-')}</td><td class="lbl"></td><td></td></tr>
      </table>
      <table class="grid">
        <thead><tr><th class="c">ลำดับ</th><th>รายการ</th><th class="r">จำนวน</th><th class="r">ราคา/หน่วย</th><th class="r">จำนวนเงิน</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="totals">
        <tr><td class="tlbl">รวมเป็นเงิน</td><td class="tval">${fmtMoney(inv.subtotal)}</td></tr>
        ${paidRow}
      </table>
      ${words}
      <div class="foot">
        <div class="sign">ผู้วางบิล / ผู้รับเงิน<div class="who"></div></div>
        <div class="sign">ผู้รับวางบิล (ลูกค้า)<div class="who"></div></div>
      </div>
    `, 'ใบแจ้งหนี้/ใบวางบิล (Invoice)');
  }
}

function statusTh(s: string): string {
  const m: Record<string, string> = { Unpaid: 'ยังไม่ชำระ', Partial: 'ชำระบางส่วน', Paid: 'ชำระแล้ว', Overdue: 'เกินกำหนด', Cancelled: 'ยกเลิก' };
  return m[s] ?? s;
}

import { Injectable } from '@nestjs/common';
import { bahtText } from '../../common/bahttext.util';
import { wrapA4, sellerHeaderHtml, esc, fmtMoney, fmtQty, thaiDate, type DocParty } from '../../common/doc-html';
import { type A4TemplateConfig, DEFAULT_A4_TEMPLATE, a4LogoHtml, a4HeaderNoteHtml, a4FooterHtml } from '../../common/a4-template';
import { PdfRenderer } from '../pdf/pdf-renderer.service';

export interface QuotePrintData {
  quote_no: string;
  status: string;
  issued_date: string | null;
  expires_date: string | null;
  currency: string;
  customer_name: string;
  notes: string | null;
  created_by: string | null;
  seller: DocParty;
  lines: { line_no: number; item_code: string | null; description: string; qty: number; unit_price: number; discount_pct: number; line_total: number }[];
  subtotal: number;
  discount_total: number;
  total: number;
  template?: A4TemplateConfig; // resolved active no-code template (presentation only); default when absent
}

// HTML → PDF template for the ใบเสนอราคา (Quotation). Same shell/formatters as the other business
// documents; rendered by the shared PdfRenderer with HTML fallback when Chromium is absent.
@Injectable()
export class QuotePdfService {
  constructor(private readonly pdf: PdfRenderer) {}

  renderToPdf(html: string): Promise<Buffer | null> {
    return this.pdf.render(html, { format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  }

  quotationHtml(q: QuotePrintData, cfg: A4TemplateConfig = DEFAULT_A4_TEMPLATE): string {
    const rows = q.lines.map((l) => `
      <tr><td class="c">${l.line_no}</td><td>${esc(l.item_code ?? '')}</td><td>${esc(l.description)}</td>
      <td class="r">${fmtQty(l.qty)}</td><td class="r">${fmtMoney(l.unit_price)}</td>
      <td class="r">${l.discount_pct ? `${fmtQty(l.discount_pct)}%` : '-'}</td><td class="r">${fmtMoney(l.line_total)}</td></tr>`).join('');
    const ccy = esc(q.currency || 'THB');
    const words = q.currency === 'THB' && cfg.totals.show_amount_in_words ? `<div class="words">( ${esc(bahtText(q.total))} )</div>` : '';
    const discountRow = q.discount_total > 0
      ? `<tr><td class="tlbl">ส่วนลด</td><td class="tval">-${fmtMoney(q.discount_total)}</td></tr>` : '';
    return wrapA4(`
      <div class="hdr">
        ${sellerHeaderHtml(q.seller, { showAddress: cfg.body.show_seller_address, showTaxId: cfg.body.show_seller_tax_id, logoHtml: a4LogoHtml(cfg, q.seller.logo_url), headerNoteHtml: a4HeaderNoteHtml(cfg) })}
        <div class="ttl">ใบเสนอราคา<div class="sub">Quotation</div><div class="stt">${esc(statusTh(q.status))}</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">ลูกค้า</td><td>${esc(q.customer_name)}</td><td class="lbl">เลขที่</td><td>${esc(q.quote_no)}</td></tr>
        <tr><td class="lbl">วันที่</td><td>${esc(thaiDate(q.issued_date))}</td><td class="lbl">ยืนราคาถึง</td><td>${esc(thaiDate(q.expires_date))}</td></tr>
      </table>
      <table class="grid">
        <thead><tr><th class="c">ลำดับ</th><th>รหัส</th><th>รายการ</th><th class="r">จำนวน</th><th class="r">ราคา/หน่วย</th><th class="r">ส่วนลด</th><th class="r">จำนวนเงิน</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="totals">
        <tr><td class="tlbl">มูลค่าก่อนส่วนลด</td><td class="tval">${fmtMoney(q.subtotal)}</td></tr>
        ${discountRow}
        <tr class="grand"><td class="tlbl">ราคาเสนอสุทธิ (${ccy})</td><td class="tval">${fmtMoney(q.total)}</td></tr>
      </table>
      ${words}
      ${q.notes ? `<div class="rmk"><span class="b">หมายเหตุ:</span> ${esc(q.notes)}</div>` : ''}
      ${a4FooterHtml(cfg, { leftDefault: 'ผู้เสนอราคา', leftWho: q.created_by ?? '', rightDefault: 'ผู้อนุมัติ / ผู้สั่งซื้อ (ลูกค้า)' })}
    `, 'ใบเสนอราคา (Quotation)', { accentColor: cfg.header.accent_color });
  }
}

function statusTh(s: string): string {
  const m: Record<string, string> = { Draft: 'ฉบับร่าง', Sent: 'ส่งแล้ว', Accepted: 'ตอบรับแล้ว', Rejected: 'ปฏิเสธ', Expired: 'หมดอายุ' };
  return m[s] ?? s;
}

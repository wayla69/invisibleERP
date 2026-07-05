import { Injectable } from '@nestjs/common';
import { bahtText } from '../../common/bahttext.util';
import { wrapA4, sellerHeaderHtml, esc, fmtMoney, fmtQty, thaiDate, formatTaxId, type DocParty } from '../../common/doc-html';
import { type A4TemplateConfig, DEFAULT_A4_TEMPLATE, a4LogoHtml, a4HeaderNoteHtml, a4FooterHtml } from '../../common/a4-template';
import { PdfRenderer } from '../pdf/pdf-renderer.service';

// Shape the print endpoint hands us (see ProcurementService.getPoForPrint).
export interface PoPrintData {
  po_no: string;
  po_date: string | null;
  expected_date: string | null;
  status: string;
  remarks: string | null;
  currency: string;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  // ผู้สั่งซื้อ (our company — the tenant raising the PO)
  buyer: { name: string; address: string; tax_id: string | null; branch_label: string | null; phone: string | null; logo_url?: string | null };
  // ผู้ขาย/ผู้จำหน่าย (the supplier the PO is issued to)
  vendor: { name: string; address: string | null; tax_id: string | null; contact: string | null; phone: string | null; payment_terms: string | null };
  lines: { item_id: string | null; description: string | null; qty: number; uom: string | null; unit_price: number; amount: number }[];
  subtotal: number;
  vat_rate: number;   // 0 when the buyer is not VAT-registered → the VAT row is suppressed
  vat_amount: number;
  grand_total: number;
  template?: A4TemplateConfig; // resolved active no-code template (presentation only); default when absent
}

// HTML → PDF template for the ใบสั่งซื้อ (Purchase Order). Mirrors the Thai tax-document renderer:
// a string-built A4 HTML shell (Sarabun webfont, inline CSS) rendered by the shared PdfRenderer
// (external-service offload or pooled Chromium); if Chromium is unavailable it returns null → the
// controller falls back to serving the raw HTML (same graceful degrade as the tax docs).
@Injectable()
export class PoPdfService {
  constructor(private readonly pdf: PdfRenderer) {}

  renderToPdf(html: string): Promise<Buffer | null> {
    return this.pdf.render(html, { format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  }

  // ── ใบสั่งซื้อ (Purchase Order) — A4 ──
  purchaseOrderHtml(po: PoPrintData, cfg: A4TemplateConfig = DEFAULT_A4_TEMPLATE): string {
    const rows = po.lines.map((l, i) => `
      <tr><td class="c">${i + 1}</td><td>${esc(l.item_id ?? '')}</td><td>${esc(l.description ?? '')}</td>
      <td class="r">${fmtQty(l.qty)}</td><td class="c">${esc(l.uom ?? '')}</td>
      <td class="r">${fmtMoney(l.unit_price)}</td><td class="r">${fmtMoney(l.amount)}</td></tr>`).join('');
    const ccy = esc(po.currency || 'THB');
    // Baht-text only makes sense in THB; a foreign-currency PO just shows the figure.
    const words = po.currency === 'THB' && cfg.totals.show_amount_in_words ? `<div class="words">( ${esc(bahtText(po.grand_total))} )</div>` : '';
    const vatRow = po.vat_rate > 0
      ? `<tr><td class="tlbl">ภาษีมูลค่าเพิ่ม ${(po.vat_rate * 100).toFixed(0)}%</td><td class="tval">${fmtMoney(po.vat_amount)}</td></tr>`
      : '';
    // Buyer = our company (the PO issuer); reuse the shared seller-header helper so the no-code template's
    // logo / header-note / accent apply identically to the PO as to the other A4 documents.
    const buyer: DocParty = { name: po.buyer.name, address: po.buyer.address, tax_id: po.buyer.tax_id, branch_label: po.buyer.branch_label, phone: po.buyer.phone, logo_url: po.buyer.logo_url ?? null };
    return wrapA4(`
      <div class="hdr">
        ${sellerHeaderHtml(buyer, { showAddress: cfg.body.show_seller_address, showTaxId: cfg.body.show_seller_tax_id, logoHtml: a4LogoHtml(cfg, buyer.logo_url), headerNoteHtml: a4HeaderNoteHtml(cfg) })}
        <div class="ttl">ใบสั่งซื้อ<div class="sub">Purchase Order</div><div class="stt">${esc(statusTh(po.status))}</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">ผู้ขาย (ผู้จำหน่าย)</td><td>${esc(po.vendor.name)}</td><td class="lbl">เลขที่ใบสั่งซื้อ</td><td>${esc(po.po_no)}</td></tr>
        <tr><td class="lbl">ที่อยู่</td><td>${esc(po.vendor.address ?? '-')}</td><td class="lbl">วันที่</td><td>${esc(thaiDate(po.po_date))}</td></tr>
        <tr><td class="lbl">เลขประจำตัวผู้เสียภาษีผู้ขาย</td><td>${esc(po.vendor.tax_id ? formatTaxId(po.vendor.tax_id) : '-')}</td><td class="lbl">กำหนดส่งมอบ</td><td>${esc(thaiDate(po.expected_date))}</td></tr>
        <tr><td class="lbl">ผู้ติดต่อ</td><td>${esc([po.vendor.contact, po.vendor.phone].filter(Boolean).join(' · ') || '-')}</td><td class="lbl">เงื่อนไขชำระเงิน / สกุลเงิน</td><td>${esc(po.vendor.payment_terms ?? '-')} · ${ccy}</td></tr>
      </table>
      <table class="grid">
        <thead><tr><th class="c">ลำดับ</th><th>รหัสสินค้า</th><th>รายการ</th><th class="r">จำนวน</th><th class="c">หน่วย</th><th class="r">ราคา/หน่วย</th><th class="r">จำนวนเงิน</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="totals">
        <tr><td class="tlbl">มูลค่าสินค้า/บริการ</td><td class="tval">${fmtMoney(po.subtotal)}</td></tr>
        ${vatRow}
        <tr class="grand"><td class="tlbl">จำนวนเงินรวมทั้งสิ้น (${ccy})</td><td class="tval">${fmtMoney(po.grand_total)}</td></tr>
      </table>
      ${words}
      ${po.remarks ? `<div class="rmk"><span class="b">หมายเหตุ:</span> ${esc(po.remarks)}</div>` : ''}
      ${a4FooterHtml(cfg, { leftDefault: 'ผู้จัดทำ / ผู้สั่งซื้อ', leftWho: po.created_by ?? '', rightDefault: 'ผู้อนุมัติ', rightWho: `${po.approved_by ?? ''}${po.approved_at ? ` · ${thaiDate(po.approved_at)}` : ''}` })}
    `, 'ใบสั่งซื้อ (Purchase Order)', { accentColor: cfg.header.accent_color });
  }
}

// Thai label for the PO workflow status shown in the header.
function statusTh(s: string): string {
  const m: Record<string, string> = { Draft: 'ฉบับร่าง', Pending: 'รออนุมัติ', Approved: 'อนุมัติแล้ว', Cancelled: 'ยกเลิก', Closed: 'ปิดแล้ว' };
  return m[s] ?? s;
}

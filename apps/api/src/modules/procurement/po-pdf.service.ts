import { Injectable } from '@nestjs/common';
import { bahtText } from '../../common/bahttext.util';
import { wrapA4, sellerHeaderHtml, esc, fmtMoney, fmtQty, thaiDate, thaiDateTime, formatTaxId, type DocParty } from '../../common/doc-html';
import { type A4TemplateConfig, DEFAULT_A4_TEMPLATE, a4LogoHtml, a4HeaderNoteHtml } from '../../common/a4-template';
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
  vendor: { code: string | null; name: string; address: string | null; tax_id: string | null; contact: string | null; phone: string | null; payment_terms: string | null };
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
      <div class="cards">
        <div class="card">
          <h4>ผู้ขาย / ผู้จำหน่าย</h4>
          <div class="name">${po.vendor.code ? `${esc(po.vendor.code)} — ` : ''}${esc(po.vendor.name)}</div>
          ${po.vendor.address ? `<div>${esc(po.vendor.address)}</div>` : ''}
          ${po.vendor.tax_id ? `<div>เลขผู้เสียภาษี ${esc(formatTaxId(po.vendor.tax_id))}</div>` : ''}
          ${(po.vendor.contact || po.vendor.phone) ? `<div>${esc([po.vendor.contact, po.vendor.phone && `โทร. ${po.vendor.phone}`].filter(Boolean).join(' · '))}</div>` : ''}
        </div>
        <div class="card">
          <h4>รายละเอียดใบสั่งซื้อ</h4>
          <div class="kv">
            <div class="k">เลขที่ใบสั่งซื้อ</div><div class="v">${esc(po.po_no)}</div>
            <div class="k">วันที่</div><div>${esc(thaiDate(po.po_date))}</div>
            <div class="k">กำหนดส่งมอบ</div><div>${esc(thaiDate(po.expected_date))}</div>
            <div class="k">เงื่อนไขชำระเงิน</div><div>${esc(po.vendor.payment_terms ?? '-')}</div>
            <div class="k">สกุลเงิน</div><div>${ccy}</div>
          </div>
        </div>
      </div>
      <table class="grid pogrid">
        <thead><tr><th class="c">ลำดับ</th><th>รหัสสินค้า</th><th>รายการ</th><th class="r">จำนวน</th><th class="c">หน่วย</th><th class="r">ราคา/หน่วย</th><th class="r">จำนวนเงิน</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="totals card">
        <tr><td class="tlbl">มูลค่าสินค้า/บริการ</td><td class="tval">${fmtMoney(po.subtotal)}</td></tr>
        ${vatRow}
        <tr class="grand"><td class="tlbl">จำนวนเงินรวมทั้งสิ้น (${ccy})</td><td class="tval">${fmtMoney(po.grand_total)}</td></tr>
      </table>
      ${words}
      ${po.remarks ? `<div class="rmk"><span class="b">หมายเหตุ:</span> ${esc(po.remarks)}</div>` : ''}
      ${poFooterHtml(cfg, po)}
    `, 'ใบสั่งซื้อ (Purchase Order)', { accentColor: cfg.header.accent_color });
  }
}

// PO-specific footer: the preparer and approver are recorded system actions (createdBy / approvedBy +
// approvedAt from the real maker-checker workflow — see ProcurementService.approvePo), so they render as an
// electronic-approval stamp rather than a blank line for a wet-ink signature. There is no "checked by" step
// in the PO workflow (unlike the maker-checker-APPROVER pattern, this is a maker-approver PO), so that middle
// box stays a plain blank signature line — never fabricate a stamp for a review that didn't happen.
function poFooterHtml(cfg: A4TemplateConfig, po: PoPrintData): string {
  const terms = cfg.footer.terms_text ? `<div class="terms">${esc(cfg.footer.terms_text)}</div>` : '';
  const extra = cfg.footer.extra_lines.map((l) => `<div class="fline">${esc(l)}</div>`).join('');
  const preparedCap = cfg.footer.prepared_by_label || 'ผู้จัดทำ / ผู้สั่งซื้อ';
  const approvedCap = cfg.footer.approved_by_label || 'ผู้อนุมัติ';

  const eStamp = (label: string, verb: string, who: string | null, when: string | null) => who
    ? `<div class="esign"><div class="cap">${esc(label)}</div>
         <div class="stamp"><span class="tick">✓</span> ${esc(verb)}ทางอิเล็กทรอนิกส์ผ่านระบบ<br/><b>${esc(who)}</b>${when ? `<br/>${esc(when)}` : ''}</div>
       </div>`
    : `<div class="sign">${esc(label)}<div class="who"></div></div>`;

  return `${terms}${extra}
    <div class="foot foot3">
      ${eStamp(preparedCap, 'จัดทำ', po.created_by, po.po_date ? thaiDate(po.po_date) : null)}
      <div class="sign">ผู้ตรวจสอบ<div class="who"></div></div>
      ${eStamp(approvedCap, 'อนุมัติ', po.approved_by, po.approved_at ? thaiDateTime(po.approved_at) : null)}
    </div>`;
}

// Thai label for the PO workflow status shown in the header.
function statusTh(s: string): string {
  const m: Record<string, string> = { Draft: 'ฉบับร่าง', Pending: 'รออนุมัติ', Approved: 'อนุมัติแล้ว', Cancelled: 'ยกเลิก', Closed: 'ปิดแล้ว' };
  return m[s] ?? s;
}

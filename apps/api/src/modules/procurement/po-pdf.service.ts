import { Injectable } from '@nestjs/common';
import { bahtText } from '../../common/bahttext.util';
import { formatTaxId } from '../tax/documents/tax-docs.snapshot';
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
  buyer: { name: string; address: string; tax_id: string | null; branch_label: string | null; phone: string | null };
  // ผู้ขาย/ผู้จำหน่าย (the supplier the PO is issued to)
  vendor: { name: string; address: string | null; tax_id: string | null; contact: string | null; phone: string | null; payment_terms: string | null };
  lines: { item_id: string | null; description: string | null; qty: number; uom: string | null; unit_price: number; amount: number }[];
  subtotal: number;
  vat_rate: number;   // 0 when the buyer is not VAT-registered → the VAT row is suppressed
  vat_amount: number;
  grand_total: number;
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
  purchaseOrderHtml(po: PoPrintData): string {
    const rows = po.lines.map((l, i) => `
      <tr><td class="c">${i + 1}</td><td>${esc(l.item_id ?? '')}</td><td>${esc(l.description ?? '')}</td>
      <td class="r">${fmtQty(l.qty)}</td><td class="c">${esc(l.uom ?? '')}</td>
      <td class="r">${fmtMoney(l.unit_price)}</td><td class="r">${fmtMoney(l.amount)}</td></tr>`).join('');
    const ccy = esc(po.currency || 'THB');
    // Baht-text only makes sense in THB; a foreign-currency PO just shows the figure.
    const words = po.currency === 'THB' ? `<div class="words">( ${esc(bahtText(po.grand_total))} )</div>` : '';
    const vatRow = po.vat_rate > 0
      ? `<tr><td class="tlbl">ภาษีมูลค่าเพิ่ม ${(po.vat_rate * 100).toFixed(0)}%</td><td class="tval">${fmtMoney(po.vat_amount)}</td></tr>`
      : '';
    return wrapA4(`
      <div class="hdr">
        <div>
          <div class="t1">${esc(po.buyer.name)}</div>
          <div>${esc(po.buyer.address)}</div>
          ${po.buyer.tax_id ? `<div>เลขประจำตัวผู้เสียภาษีอากร ${esc(formatTaxId(po.buyer.tax_id))} &nbsp; (${esc(po.buyer.branch_label ?? 'สำนักงานใหญ่')})</div>` : ''}
          ${po.buyer.phone ? `<div>โทร. ${esc(po.buyer.phone)}</div>` : ''}
        </div>
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
      <div class="foot">
        <div class="sign">ผู้จัดทำ / ผู้สั่งซื้อ<div class="who">${esc(po.created_by ?? '')}</div></div>
        <div class="sign">ผู้อนุมัติ<div class="who">${esc(po.approved_by ?? '')}${po.approved_at ? ` · ${esc(thaiDate(po.approved_at))}` : ''}</div></div>
      </div>
    `, 'ใบสั่งซื้อ (Purchase Order)');
  }
}

// ── A4 shell (mirrors tax-docs-pdf.service.ts wrapA4; brand #1E3C72) ──
function wrapA4(body: string, title: string): string {
  return `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"/><title>${esc(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box} body{font-family:'Sarabun',sans-serif;color:#1a1a1a;font-size:12px;margin:0}
    .hdr{display:flex;justify-content:space-between;border-bottom:2px solid #1E3C72;padding-bottom:6px;margin-bottom:8px}
    .t1{font-size:16px;font-weight:700;color:#1E3C72} .ttl{font-size:15px;font-weight:700;color:#1E3C72;text-align:right}
    .sub{font-size:11px;font-weight:400;color:#555;letter-spacing:.06em} .stt{font-size:11px;font-weight:600;color:#b00}
    .ct{text-align:center} .b{font-weight:700} .r{text-align:right} .c{text-align:center}
    table{width:100%;border-collapse:collapse} table.meta td{padding:2px 6px} td.lbl{color:#555;width:18%}
    table.grid{margin:8px 0} table.grid th{background:#1E3C72;color:#fff;padding:5px;text-align:left;font-size:11px}
    table.grid td{padding:4px 6px;border-bottom:1px solid #e0e0e0} table.grid tr.grand td{border-top:2px solid #1E3C72;font-weight:700}
    table.totals{width:45%;margin-left:auto;margin-top:6px} table.totals td{padding:3px 6px} td.tval{text-align:right;font-weight:600}
    table.totals tr.grand td{border-top:2px solid #1E3C72;color:#1E3C72;font-size:13px}
    .words{margin-top:8px;font-weight:600;color:#1E3C72} .rmk{margin-top:8px;font-size:11px}
    .foot{margin-top:28px;display:flex;justify-content:space-between}
    .sign{width:45%;text-align:center;border-top:1px solid #999;padding-top:4px;color:#555}
    .sign .who{margin-top:18px;color:#1a1a1a;font-weight:600}
  </style></head><body>${body}</body></html>`;
}

// Thai label for the PO workflow status shown in the header.
function statusTh(s: string): string {
  const m: Record<string, string> = { Draft: 'ฉบับร่าง', Pending: 'รออนุมัติ', Approved: 'อนุมัติแล้ว', Cancelled: 'ยกเลิก', Closed: 'ปิดแล้ว' };
  return m[s] ?? s;
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtMoney(x: number): string {
  return (Math.round((Number(x) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtQty(x: number): string {
  return (Number(x) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
}
function thaiDate(v: unknown): string {
  if (!v) return '-';
  const d = new Date(v as string);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear() + 543}`; // พ.ศ.
}

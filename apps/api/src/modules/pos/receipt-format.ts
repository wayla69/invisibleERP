// Pure receipt formatters (no Nest deps → unit-testable). An 80mm thermal HTML slip + an ESC/POS-friendly
// plain-text rendering. The body is a pure function of the sale; only the copy/reprint flags vary.
import { bahtText } from '../../common/bahttext.util';
import { formatTaxId } from '../tax-docs/tax-docs.snapshot';

export interface ReceiptModel {
  sale_no: string;
  date: string;
  shop: { name: string; tax_id: string; branch_label: string; address: string; phone?: string };
  lines: { name: string; qty: number; unit_price: number; amount: number; discount_pct: number }[];
  subtotal: number;
  discount: number;
  service_charge: number; // VATable service income (ค่าบริการ) — 0 for retail; >0 for large-party dine-in
  vat: number;
  total: number;
  tip: number;
  tenders: { method: string; amount: number; status: string }[];
  points_earned: number;
  points_used: number;
  reprint_count: number;
  copy: boolean;
}

const money = (x: number) => (Math.round((Number(x) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyf = (x: number) => (Number(x) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── 80mm HTML slip ──
export function receiptHtml(m: ReceiptModel): string {
  const lineRows = m.lines.map((l) => {
    const head = `<div class="ln"><span class="nm">${esc(l.name)}</span><span class="amt">${money(l.amount)}</span></div>`;
    const qtyRow = `<div class="sub">${qtyf(l.qty)} × ${money(l.unit_price)}</div>`;
    const disc = l.discount_pct > 0 ? `<div class="sub">ส่วนลด -${qtyf(l.discount_pct)}%</div>` : '';
    return head + qtyRow + disc;
  }).join('');
  const totalRow = (label: string, val: string, bold = false) => `<div class="tr${bold ? ' b' : ''}"><span>${label}</span><span>${val}</span></div>`;
  const totals = [
    totalRow('รวมย่อย', money(m.subtotal)),
    m.discount > 0 ? totalRow('ส่วนลด', '-' + money(m.discount)) : '',
    m.service_charge > 0 ? totalRow('ค่าบริการ', money(m.service_charge)) : '',
    totalRow('ภาษีมูลค่าเพิ่ม 7%', money(m.vat)),
    totalRow('รวมทั้งสิ้น', money(m.total), true),
    m.tip > 0 ? totalRow('ทิป', money(m.tip)) : '',
  ].join('');
  const tenders = m.tenders.map((t) => `<div class="tr"><span>${esc(t.method)}</span><span>${money(t.amount)}</span></div>`).join('');
  const points = (m.points_earned > 0 || m.points_used > 0)
    ? `<div class="dash"></div>${m.points_earned > 0 ? `<div class="tr"><span>แต้มสะสมที่ได้รับ</span><span>${qtyf(m.points_earned)}</span></div>` : ''}${m.points_used > 0 ? `<div class="tr"><span>แต้มที่ใช้</span><span>${qtyf(m.points_used)}</span></div>` : ''}`
    : '';
  const copyBanner = m.copy ? `<div class="copy">สำเนา (COPY)</div>` : '';
  const reprintNote = m.reprint_count > 0 ? `<div class="ft">พิมพ์ซ้ำครั้งที่ ${m.reprint_count}</div>` : '';
  const phone = m.shop.phone ? `<div class="c sm">โทร. ${esc(m.shop.phone)}</div>` : '';
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"/>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&display=swap');
  * { box-sizing: border-box; }
  body { font-family: 'Sarabun', sans-serif; width: 80mm; margin: 0 auto; padding: 4mm; color: #000; font-size: 12px; }
  .c { text-align: center; } .r { text-align: right; } .b { font-weight: 700; } .sm { font-size: 11px; }
  .shop { font-weight: 700; font-size: 15px; text-align: center; }
  .title { text-align: center; font-weight: 700; font-size: 14px; margin-top: 4px; }
  .copy { text-align: center; font-weight: 700; color: #c00; border: 1px solid #c00; margin: 4px 0; padding: 2px; }
  .dash { border-top: 1px dashed #000; margin: 5px 0; }
  .ln { display: flex; justify-content: space-between; font-weight: 700; }
  .ln .nm { flex: 1; padding-right: 6px; } .ln .amt { white-space: nowrap; }
  .sub { font-size: 11px; color: #333; padding-left: 4px; }
  .tr { display: flex; justify-content: space-between; } .tr.b { font-weight: 700; font-size: 13px; }
  .ft { text-align: center; font-size: 11px; margin-top: 2px; }
  .words { text-align: center; font-size: 11px; font-style: italic; margin-top: 3px; }
</style></head><body>
  <div class="shop">${esc(m.shop.name)}</div>
  <div class="c sm">เลขผู้เสียภาษี ${formatTaxId(m.shop.tax_id)}</div>
  <div class="c sm">${esc(m.shop.branch_label)}</div>
  <div class="c sm">${esc(m.shop.address)}</div>
  ${phone}
  <div class="title">ใบเสร็จรับเงิน</div>
  ${copyBanner}
  <div class="dash"></div>
  ${lineRows}
  <div class="dash"></div>
  ${totals}
  <div class="words">(${esc(bahtText(m.total))})</div>
  <div class="dash"></div>
  ${tenders}
  ${points}
  <div class="dash"></div>
  <div class="ft">เลขที่ขาย: ${esc(m.sale_no)}  ·  ${esc(m.date)}</div>
  <div class="ft">ขอบคุณที่ใช้บริการ</div>
  <div class="ft">* เอกสารนี้ไม่ใช่ใบกำกับภาษี ขอใบกำกับภาษีโปรดแจ้งพนักงาน *</div>
  ${reprintNote}
</body></html>`;
}

// ── ESC/POS-friendly plain text (42-col) ──
export function receiptEscPos(m: ReceiptModel): string {
  const W = 42;
  const center = (s: string) => { const pad = Math.max(0, Math.floor((W - s.length) / 2)); return ' '.repeat(pad) + s; };
  const lr = (l: string, r: string) => { const space = Math.max(1, W - l.length - r.length); return l + ' '.repeat(space) + r; };
  const dash = '-'.repeat(W);
  const out: string[] = [];
  out.push(center(m.shop.name));
  out.push(center('เลขผู้เสียภาษี ' + formatTaxId(m.shop.tax_id)));
  out.push(center(m.shop.branch_label));
  if (m.shop.phone) out.push(center('โทร. ' + m.shop.phone));
  out.push(center('ใบเสร็จรับเงิน'));
  if (m.copy) out.push(center('*** สำเนา (COPY) ***'));
  out.push(dash);
  for (const l of m.lines) {
    out.push(l.name);
    out.push(lr(`  ${qtyf(l.qty)} x ${money(l.unit_price)}`, money(l.amount)));
    if (l.discount_pct > 0) out.push(`  ส่วนลด -${qtyf(l.discount_pct)}%`);
  }
  out.push(dash);
  out.push(lr('รวมย่อย', money(m.subtotal)));
  if (m.discount > 0) out.push(lr('ส่วนลด', '-' + money(m.discount)));
  if (m.service_charge > 0) out.push(lr('ค่าบริการ', money(m.service_charge)));
  out.push(lr('ภาษีมูลค่าเพิ่ม 7%', money(m.vat)));
  out.push(lr('รวมทั้งสิ้น', money(m.total)));
  if (m.tip > 0) out.push(lr('ทิป', money(m.tip)));
  out.push(center('(' + bahtText(m.total) + ')'));
  out.push(dash);
  for (const t of m.tenders) out.push(lr(t.method, money(t.amount)));
  if (m.points_earned > 0) out.push(lr('แต้มสะสมที่ได้รับ', qtyf(m.points_earned)));
  if (m.points_used > 0) out.push(lr('แต้มที่ใช้', qtyf(m.points_used)));
  out.push(dash);
  out.push(center('เลขที่ขาย: ' + m.sale_no));
  out.push(center(m.date));
  out.push(center('ขอบคุณที่ใช้บริการ'));
  out.push(center('* ไม่ใช่ใบกำกับภาษี *'));
  if (m.reprint_count > 0) out.push(center('พิมพ์ซ้ำครั้งที่ ' + m.reprint_count));
  return out.join('\n') + '\n';
}

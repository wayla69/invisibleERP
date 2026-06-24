// Pure receipt rendering + the presentation template that drives it (Platform Phase 10 — A3). Extracted
// from receipt.service.ts so BOTH the live render (ReceiptService) and the document-template designer's
// live preview (DocumentTemplatesService) share ONE source of truth — no Nest deps, unit-testable. A
// receipt is a NON-fiscal courtesy document; the template affects presentation only and never the numbers.

export type ReceiptLang = 'th' | 'en' | 'both';

const n = (x: any) => Number(x) || 0;
const baht = (x: any) => n(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Attribute-context encode: also neutralise the quotes that could close an attribute (XSS via e.g. logo src).
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Receipt label dictionary. `both` renders "TH / EN" so a bilingual slip is one toggle away.
const L = {
  th: { subtotal: 'ยอดรวม', discount: 'ส่วนลด', vat: 'ภาษีมูลค่าเพิ่ม', total: 'รวมสุทธิ', tip: 'ทิป', paidBy: 'ชำระโดย', copy: 'สำเนา', taxInv: 'ใบกำกับภาษีอย่างย่อ', taxId: 'เลขประจำตัวผู้เสียภาษี', no: 'เลขที่', thanks: 'ขอบคุณที่ใช้บริการ', print: 'พิมพ์', receipt: 'ใบเสร็จรับเงิน' },
  en: { subtotal: 'Subtotal', discount: 'Discount', vat: 'VAT', total: 'Total', tip: 'Tip', paidBy: 'Paid by', copy: 'COPY', taxInv: 'Abbreviated tax invoice', taxId: 'Tax ID', no: 'No.', thanks: 'Thank you', print: 'Print', receipt: 'Receipt' },
} as const;

// Resolve labels for a language; `both` joins TH / EN.
function labels(lang: ReceiptLang) {
  if (lang === 'th') return L.th;
  if (lang === 'en') return L.en;
  const both: Record<string, string> = {};
  for (const k of Object.keys(L.th) as (keyof typeof L.th)[]) both[k] = `${L.th[k]} / ${L.en[k]}`;
  return both as typeof L.th;
}

export type ReceiptData = {
  sale_no: string;
  date: string | null;
  is_copy: boolean;
  lang: ReceiptLang;
  seller: { name: string; legal_name?: string | null; branch_label?: string | null; tax_id?: string | null; address?: string | null; vat_registered: boolean; logo_url?: string | null; tagline?: string | null; show_logo?: boolean };
  items: { description: string; qty: number; unit_price: number; amount: number }[];
  subtotal: number;
  discount: number;
  vat: number;
  total: number;
  tip: number;
  payment_method: string;
  tax_invoice_no?: string | null;
  promptpay_id?: string | null;
  template?: ReceiptTemplateConfig; // resolved active template (presentation only); default applied when absent
};

// ── presentation template ─────────────────────────────────────────────────────────────────────────────
// A receipt template tweaks ONLY presentation: which header/body rows show, an accent colour, a body font
// scale, a custom thank-you + extra footer lines, and the paper width. It can never change the amounts, and
// the seller name + total always render regardless of config (core integrity).
export type ReceiptTemplateConfig = {
  header: { show_logo: boolean; header_note: string };
  body: { show_branch: boolean; show_address: boolean; show_tax_id: boolean; accent_color: string; font_scale: number };
  footer: { thanks_text: string; extra_lines: string[] };
  paper: { width_mm: number };
};

export const DEFAULT_RECEIPT_TEMPLATE: ReceiptTemplateConfig = {
  header: { show_logo: true, header_note: '' },
  body: { show_branch: true, show_address: true, show_tax_id: true, accent_color: '', font_scale: 1 },
  footer: { thanks_text: '', extra_lines: [] },
  paper: { width_mm: 80 },
};

const toBool = (v: any, dflt: boolean) => (v === undefined || v === null ? dflt : v !== false && v !== 'false' && v !== 0 && v !== '0');
const clampNum = (v: any, lo: number, hi: number, dflt: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt; };
const str = (v: any, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const HEX = /^#[0-9a-fA-F]{6}$/;

// Validate + default a stored (or posted) config blob into a complete, safe ReceiptTemplateConfig.
export function normalizeReceiptTemplate(raw: any): ReceiptTemplateConfig {
  const r = raw && typeof raw === 'object' ? raw : {};
  const h = r.header ?? {}, b = r.body ?? {}, f = r.footer ?? {}, p = r.paper ?? {};
  const accent = typeof b.accent_color === 'string' && HEX.test(b.accent_color) ? b.accent_color : '';
  const extra = Array.isArray(f.extra_lines) ? f.extra_lines.filter((x: any) => typeof x === 'string').slice(0, 5).map((x: string) => x.slice(0, 120)) : [];
  return {
    header: { show_logo: toBool(h.show_logo, true), header_note: str(h.header_note, 120) },
    body: {
      show_branch: toBool(b.show_branch, true), show_address: toBool(b.show_address, true), show_tax_id: toBool(b.show_tax_id, true),
      accent_color: accent, font_scale: clampNum(b.font_scale, 0.8, 1.4, 1),
    },
    footer: { thanks_text: str(f.thanks_text, 120), extra_lines: extra },
    paper: { width_mm: Math.round(clampNum(p.width_mm, 58, 112, 80)) },
  };
}

// ── HTML slip (80mm default) ──
export function renderReceiptHtml(d: ReceiptData, cfg: ReceiptTemplateConfig = DEFAULT_RECEIPT_TEMPLATE): string {
  const t = labels(d.lang);
  const htmlLang = d.lang === 'en' ? 'en' : 'th';
  const pageW = cfg.paper.width_mm, bodyW = pageW - 8, baseFont = Math.round(13 * cfg.body.font_scale);
  const accentCss = cfg.body.accent_color ? `h1{color:${cfg.body.accent_color}}.tot td{color:${cfg.body.accent_color}}` : '';
  const rows = d.items.map((l) => `<tr><td>${esc(l.description)}</td><td class="q">${l.qty}</td><td class="m">${baht(l.amount)}</td></tr>`).join('');
  const copy = d.is_copy ? `<div class="copy">${esc(t.copy)}</div>` : '';
  const vatLine = d.seller.vat_registered ? `<tr><td colspan="2">${esc(t.vat)}</td><td class="m">${baht(d.vat)}</td></tr>` : '';
  const tipLine = d.tip > 0 ? `<tr><td colspan="2">${esc(t.tip)}</td><td class="m">${baht(d.tip)}</td></tr>` : '';
  const inv = d.tax_invoice_no ? `<div class="muted">${esc(t.taxInv)} ${esc(d.tax_invoice_no)}</div>` : '';
  const footerThanks = cfg.footer.thanks_text || t.thanks;
  return `<!doctype html><html lang="${htmlLang}"><head><meta charset="utf-8"><title>${esc(t.receipt)} ${esc(d.sale_no)}</title>
<style>@page{size:${pageW}mm auto;margin:4mm}body{font-family:'TH Sarabun New',Tahoma,monospace;width:${bodyW}mm;margin:0 auto;font-size:${baseFont}px;color:#000}
h1{font-size:16px;text-align:center;margin:0}.muted{color:#444;font-size:11px;text-align:center}.copy{text-align:center;font-weight:bold;border:1px dashed #000;margin:4px 0;padding:2px}
.logo{display:block;max-height:48px;max-width:60mm;margin:0 auto 4px}.tagline{text-align:center;font-size:11px;font-style:italic;color:#333}
table{width:100%;border-collapse:collapse;margin-top:6px}td{padding:1px 0;vertical-align:top}.q{text-align:center;width:24px}.m{text-align:right;width:64px}
.sep{border-top:1px dashed #000}.tot td{font-weight:bold}.foot{text-align:center;margin-top:8px;font-size:11px}@media print{button{display:none}}${accentCss}</style></head>
<body onload="if(location.search.indexOf('print')>=0)window.print()">
${d.seller.logo_url && d.seller.show_logo && cfg.header.show_logo ? `<img class="logo" src="${escAttr(d.seller.logo_url)}" alt="">` : ''}
<h1>${esc(d.seller.legal_name || d.seller.name)}</h1>
${d.seller.tagline ? `<div class="tagline">${esc(d.seller.tagline)}</div>` : ''}
${cfg.header.header_note ? `<div class="muted">${esc(cfg.header.header_note)}</div>` : ''}
${cfg.body.show_branch && d.seller.branch_label ? `<div class="muted">${esc(d.seller.branch_label)}</div>` : ''}
${cfg.body.show_address && d.seller.address ? `<div class="muted">${esc(d.seller.address)}</div>` : ''}
${cfg.body.show_tax_id && d.seller.tax_id ? `<div class="muted">${esc(t.taxId)} ${esc(d.seller.tax_id)}</div>` : ''}
${copy}
<div class="muted">${esc(t.no)} ${esc(d.sale_no)} · ${esc(d.date ?? '')}</div>${inv}
<table><tbody>${rows}</tbody></table>
<table class="sep"><tbody>
<tr><td colspan="2">${esc(t.subtotal)}</td><td class="m">${baht(d.subtotal)}</td></tr>
${d.discount > 0 ? `<tr><td colspan="2">${esc(t.discount)}</td><td class="m">-${baht(d.discount)}</td></tr>` : ''}
${vatLine}
<tr class="tot"><td colspan="2">${esc(t.total)}</td><td class="m">${baht(d.total)}</td></tr>
${tipLine}
<tr><td colspan="2">${esc(t.paidBy)} ${esc(d.payment_method)}</td><td class="m"></td></tr>
</tbody></table>
<button onclick="window.print()">${esc(t.print)}</button>
<div class="foot">${esc(footerThanks)}</div>${cfg.footer.extra_lines.map((l) => `\n<div class="foot">${esc(l)}</div>`).join('')}
</body></html>`;
}

// ── ESC/POS (thermal) ──
export function renderReceiptEscPos(d: ReceiptData, cfg: ReceiptTemplateConfig = DEFAULT_RECEIPT_TEMPLATE): string {
  const t = labels(d.lang);
  const ESC = '\x1b', GS = '\x1d';
  const init = ESC + '@';
  const center = ESC + 'a' + '\x01', left = ESC + 'a' + '\x00';
  const boldOn = ESC + 'E' + '\x01', boldOff = ESC + 'E' + '\x00';
  const cut = GS + 'V' + '\x42' + '\x00';
  const W = 42; // 80mm @ Font A
  const row = (l: string, r: string) => { const pad = Math.max(1, W - l.length - r.length); return l + ' '.repeat(pad) + r + '\n'; };
  let s = init + center + boldOn + (d.seller.legal_name || d.seller.name) + '\n' + boldOff;
  if (cfg.header.header_note) s += cfg.header.header_note + '\n';
  if (cfg.body.show_branch && d.seller.branch_label) s += d.seller.branch_label + '\n';
  if (cfg.body.show_address && d.seller.address) s += d.seller.address + '\n';
  if (cfg.body.show_tax_id && d.seller.tax_id) s += t.taxId + ' ' + d.seller.tax_id + '\n';
  if (d.is_copy) s += boldOn + `*** ${t.copy} ***\n` + boldOff;
  s += left + '-'.repeat(W) + '\n';
  s += d.sale_no + '  ' + (d.date ?? '') + '\n';
  if (d.tax_invoice_no) s += t.taxInv + ' ' + d.tax_invoice_no + '\n';
  s += '-'.repeat(W) + '\n';
  for (const l of d.items) s += row(`${l.qty}x ${l.description}`.slice(0, W - 10), baht(l.amount));
  s += '-'.repeat(W) + '\n';
  s += row(t.subtotal, baht(d.subtotal));
  if (d.discount > 0) s += row(t.discount, '-' + baht(d.discount));
  if (d.seller.vat_registered) s += row(t.vat, baht(d.vat));
  s += boldOn + row(t.total, baht(d.total)) + boldOff;
  if (d.tip > 0) s += row(t.tip, baht(d.tip));
  s += row(t.paidBy, d.payment_method);
  const thanks = cfg.footer.thanks_text || t.thanks;
  s += '\n' + center + thanks + '\n';
  for (const ln of cfg.footer.extra_lines) s += center + ln + '\n';
  s += '\n\n' + cut;
  return s;
}

// A representative sale for the live preview (so the designer shows real layout without touching a real sale).
export function buildSampleReceiptData(seller: ReceiptData['seller'], lang: ReceiptLang = 'th'): ReceiptData {
  const items = [
    { description: 'กาแฟลาเต้ (ร้อน)', qty: 2, unit_price: 55, amount: 110 },
    { description: 'ครัวซองต์เนยสด', qty: 1, unit_price: 65, amount: 65 },
    { description: 'เค้กช็อกโกแลต', qty: 1, unit_price: 95, amount: 95 },
  ];
  const subtotal = items.reduce((a, l) => a + l.amount, 0); // 270
  const discount = 20;
  const vat = seller.vat_registered ? Math.round((subtotal - discount) * 0.07 * 100) / 100 : 0;
  const total = Math.round((subtotal - discount + vat) * 100) / 100;
  return {
    sale_no: 'SALE-PREVIEW', date: '2026-06-24', is_copy: false, lang,
    seller, items, subtotal, discount, vat, total, tip: 0, payment_method: 'PromptPay',
  };
}

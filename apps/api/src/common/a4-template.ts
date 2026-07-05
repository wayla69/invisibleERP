// Pure, Nest-free presentation template for the A4 business documents (quotation, purchase order, payslip,
// …) — the A4 analogue of receipt-render.ts. ONE source of truth shared by the live renderers (the
// per-module *-pdf.service.ts) and the document-template designer's live preview
// (DocumentTemplatesService), so a tenant authors a no-code template once and both paths agree.
//
// A template affects PRESENTATION ONLY: an accent colour, an optional logo + header note, which
// seller-identity lines show, whether the amount-in-words line prints, custom signature captions, and
// footer terms/notes. It can NEVER change amounts, and it can NEVER omit a legally-mandatory field — for a
// FISCAL document (tax invoice, ม.86/4) `normalizeA4Template(raw, { fiscal: true })` force-enables the
// seller address + tax-id lines regardless of the stored knobs (core integrity).

import { wrapA4, sellerHeaderHtml, type DocParty } from './doc-html';

export type A4TemplateConfig = {
  header: {
    show_logo: boolean;      // render the tenant logo (when the tenant has a logo_url) above the seller name
    header_note: string;     // an extra line under the seller identity block (e.g. a slogan / dept)
    accent_color: string;    // '' → the brand default (#1E3C72); else a #RRGGBB override for rules/headings
  };
  body: {
    show_seller_address: boolean;   // FISCAL: forced true
    show_seller_tax_id: boolean;    // FISCAL: forced true
  };
  totals: {
    show_amount_in_words: boolean;  // print the ( baht-text ) line under the totals (THB only)
  };
  footer: {
    terms_text: string;             // a terms/notes paragraph above the signature row
    extra_lines: string[];          // up to 5 extra footer lines
    prepared_by_label: string;      // '' → the renderer's own default caption
    approved_by_label: string;      // '' → the renderer's own default caption
  };
};

export const DEFAULT_A4_TEMPLATE: A4TemplateConfig = {
  header: { show_logo: true, header_note: '', accent_color: '' },
  body: { show_seller_address: true, show_seller_tax_id: true },
  totals: { show_amount_in_words: true },
  footer: { terms_text: '', extra_lines: [], prepared_by_label: '', approved_by_label: '' },
};

const BRAND = '#1E3C72';
const HEX = /^#[0-9a-fA-F]{6}$/;
const toBool = (v: any, dflt: boolean) => (v === undefined || v === null ? dflt : v !== false && v !== 'false' && v !== 0 && v !== '0');
const str = (v: any, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

// Validate + default a stored/posted config blob into a complete, safe A4TemplateConfig. When `fiscal` is
// set (tax invoices), the mandatory seller-identity lines are force-enabled so a knob can never drop a
// legally-required field — the whole point of the "presentation only, never omits mandatory" guarantee.
export function normalizeA4Template(raw: any, opts: { fiscal?: boolean } = {}): A4TemplateConfig {
  const r = raw && typeof raw === 'object' ? raw : {};
  const h = r.header ?? {}, b = r.body ?? {}, tt = r.totals ?? {}, f = r.footer ?? {};
  const accent = typeof h.accent_color === 'string' && HEX.test(h.accent_color) ? h.accent_color : '';
  const extra = Array.isArray(f.extra_lines)
    ? f.extra_lines.filter((x: any) => typeof x === 'string').slice(0, 5).map((x: string) => x.slice(0, 160))
    : [];
  const fiscal = !!opts.fiscal;
  return {
    header: { show_logo: toBool(h.show_logo, true), header_note: str(h.header_note, 160), accent_color: accent },
    body: {
      // fiscal docs must always show the seller address + tax id (ม.86/4) — the knob is honoured only for
      // non-fiscal documents (quotation / PO / payslip), where hiding them is a legitimate style choice.
      show_seller_address: fiscal ? true : toBool(b.show_seller_address, true),
      show_seller_tax_id: fiscal ? true : toBool(b.show_seller_tax_id, true),
    },
    totals: { show_amount_in_words: toBool(tt.show_amount_in_words, true) },
    footer: {
      terms_text: str(f.terms_text, 600), extra_lines: extra,
      prepared_by_label: str(f.prepared_by_label, 60), approved_by_label: str(f.approved_by_label, 60),
    },
  };
}

// The accent colour actually used (config override → brand default). Shared by the renderers + wrapA4 CSS.
export function a4Accent(cfg: A4TemplateConfig): string {
  return cfg.header.accent_color || BRAND;
}

// Attribute-context encode for a logo URL etc. (neutralise quotes that could close an attribute — XSS).
function escAttr(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// The optional logo <img> for the seller header (rendered only when the config enables it AND a URL exists).
export function a4LogoHtml(cfg: A4TemplateConfig, logoUrl: string | null | undefined): string {
  return cfg.header.show_logo && logoUrl ? `<img class="brandlogo" src="${escAttr(logoUrl)}" alt=""/>` : '';
}

// The optional header note line under the seller identity block.
export function a4HeaderNoteHtml(cfg: A4TemplateConfig): string {
  return cfg.header.header_note ? `<div class="hnote">${esc(cfg.header.header_note)}</div>` : '';
}

// Representative A4 document rendered through a config, for the template designer's LIVE PREVIEW. It shows
// every knob (logo, accent, header note, seller-line toggles, amount-in-words, terms/footer signatures) on a
// generic seller-header + line-grid + totals layout, so the tenant sees the effect without touching a real
// document. Pure (imports only the shared pure shell) → no DI cycle with the per-module renderers.
export function renderA4SamplePreview(
  cfg: A4TemplateConfig,
  opts: { title: string; subtitle: string; seller: DocParty },
): string {
  const money = (x: number) => (Math.round(x * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const items = [
    { d: 'สินค้า/บริการตัวอย่าง A', q: 2, p: 500 },
    { d: 'สินค้า/บริการตัวอย่าง B', q: 1, p: 1200 },
    { d: 'สินค้า/บริการตัวอย่าง C', q: 3, p: 150 },
  ];
  const rows = items.map((l, i) => `<tr><td class="c">${i + 1}</td><td>${esc(l.d)}</td><td class="r">${l.q}</td><td class="r">${money(l.p)}</td><td class="r">${money(l.q * l.p)}</td></tr>`).join('');
  const subtotal = items.reduce((a, l) => a + l.q * l.p, 0);
  const vat = Math.round(subtotal * 0.07 * 100) / 100;
  const total = subtotal + vat;
  const words = cfg.totals.show_amount_in_words ? `<div class="words">( ${esc(bahtTextSample(total))} )</div>` : '';
  return wrapA4(`
    <div class="hdr">
      ${sellerHeaderHtml(opts.seller, { showAddress: cfg.body.show_seller_address, showTaxId: cfg.body.show_seller_tax_id, logoHtml: a4LogoHtml(cfg, opts.seller.logo_url), headerNoteHtml: a4HeaderNoteHtml(cfg) })}
      <div class="ttl">${esc(opts.title)}<div class="sub">${esc(opts.subtitle)}</div><div class="stt">ตัวอย่าง / PREVIEW</div></div>
    </div>
    <table class="meta"><tr><td class="lbl">คู่ค้า</td><td>ตัวอย่าง</td><td class="lbl">เลขที่</td><td>PREVIEW-0001</td></tr></table>
    <table class="grid">
      <thead><tr><th class="c">ลำดับ</th><th>รายการ</th><th class="r">จำนวน</th><th class="r">ราคา/หน่วย</th><th class="r">จำนวนเงิน</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table class="totals">
      <tr><td class="tlbl">มูลค่าก่อนภาษี</td><td class="tval">${money(subtotal)}</td></tr>
      <tr><td class="tlbl">ภาษีมูลค่าเพิ่ม 7%</td><td class="tval">${money(vat)}</td></tr>
      <tr class="grand"><td class="tlbl">รวมทั้งสิ้น (THB)</td><td class="tval">${money(total)}</td></tr>
    </table>
    ${words}
    ${a4FooterHtml(cfg, { leftDefault: 'ผู้จัดทำ', rightDefault: 'ผู้อนุมัติ' })}
  `, `${opts.title} — ตัวอย่าง`, { accentColor: cfg.header.accent_color });
}

// A tiny Thai baht-text stand-in for the preview (the live renderers use the real common/bahttext.util).
function bahtTextSample(x: number): string {
  return `จำนวนเงินตัวอย่าง ${(Math.round(x * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} บาท`;
}

// The shared footer: an optional terms paragraph + extra lines, then the two-signature row (with optional
// caption overrides). Renderers pass their own default captions; a non-empty config label overrides them.
export function a4FooterHtml(
  cfg: A4TemplateConfig,
  signatures: { leftDefault: string; leftWho?: string; rightDefault: string; rightWho?: string },
): string {
  const terms = cfg.footer.terms_text ? `<div class="terms">${esc(cfg.footer.terms_text)}</div>` : '';
  const extra = cfg.footer.extra_lines.map((l) => `<div class="fline">${esc(l)}</div>`).join('');
  const leftCap = cfg.footer.prepared_by_label || signatures.leftDefault;
  const rightCap = cfg.footer.approved_by_label || signatures.rightDefault;
  return `${terms}${extra}
    <div class="foot">
      <div class="sign">${esc(leftCap)}<div class="who">${esc(signatures.leftWho ?? '')}</div></div>
      <div class="sign">${esc(rightCap)}<div class="who">${esc(signatures.rightWho ?? '')}</div></div>
    </div>`;
}

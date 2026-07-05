// Shared A4 document-HTML helpers for the printable business documents (quotation, delivery note, AR
// invoice, …). Mirrors the shell/formatters used by the Thai tax documents (tax-docs-pdf.service.ts) and
// the purchase order (po-pdf.service.ts) so every printed document reads as one system — same Sarabun
// webfont, brand colour #1E3C72, money/qty/Thai-Buddhist-date formatting. Pure functions, no Nest deps.

export function esc(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function fmtMoney(x: number): string {
  return (Math.round((Number(x) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtQty(x: number): string {
  return (Number(x) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
}

// dd/mm/yyyy in the Buddhist era (พ.ศ. = ค.ศ. + 543), matching the tax-document renderer.
export function thaiDate(v: unknown): string {
  if (!v) return '-';
  const d = new Date(v as string);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear() + 543}`;
}

// 13-digit Thai Tax ID as X-XXXX-XXXXX-XX-X (same shape as tax-docs.snapshot.formatTaxId). Non-13-digit
// input is returned as-is so partial/legacy values still print.
export function formatTaxId(v: unknown): string {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length !== 13) return String(v ?? '');
  return `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}`;
}

// A4 shell shared by the business documents. The CSS is a superset covering the header, party-meta table,
// line grid, totals block, amount-in-words, remarks and signature footer that these documents use.
// `opts.accentColor` overrides the brand accent (#1E3C72) for the header rules/headings + grid — driven by
// a tenant's no-code document template (presentation only; see common/a4-template.ts). A non-#RRGGBB value
// falls back to the brand default so a bad config can never break the shell.
const A4_BRAND = '#1E3C72';
const A4_HEX = /^#[0-9a-fA-F]{6}$/;
export function wrapA4(body: string, title: string, opts: { accentColor?: string } = {}): string {
  const A = opts.accentColor && A4_HEX.test(opts.accentColor) ? opts.accentColor : A4_BRAND;
  return `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"/><title>${esc(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box} body{font-family:'Sarabun',sans-serif;color:#1a1a1a;font-size:12px;margin:0}
    .hdr{display:flex;justify-content:space-between;border-bottom:2px solid ${A};padding-bottom:6px;margin-bottom:8px}
    .brandlogo{max-height:46px;max-width:180px;margin-bottom:4px;display:block} .hnote{font-size:11px;color:#555}
    .t1{font-size:16px;font-weight:700;color:${A}} .ttl{font-size:15px;font-weight:700;color:${A};text-align:right}
    .sub{font-size:11px;font-weight:400;color:#555;letter-spacing:.06em} .stt{font-size:11px;font-weight:600;color:#b00}
    .ct{text-align:center} .b{font-weight:700} .r{text-align:right} .c{text-align:center}
    table{width:100%;border-collapse:collapse} table.meta td{padding:2px 6px} td.lbl{color:#555;width:18%}
    table.grid{margin:8px 0} table.grid th{background:${A};color:#fff;padding:5px;text-align:left;font-size:11px}
    table.grid td{padding:4px 6px;border-bottom:1px solid #e0e0e0} table.grid tr.grand td{border-top:2px solid ${A};font-weight:700}
    table.totals{width:45%;margin-left:auto;margin-top:6px} table.totals td{padding:3px 6px} td.tval{text-align:right;font-weight:600}
    table.totals tr.grand td{border-top:2px solid ${A};color:${A};font-size:13px}
    .words{margin-top:8px;font-weight:600;color:${A}} .rmk{margin-top:8px;font-size:11px}
    .terms{margin-top:10px;font-size:11px;color:#333;white-space:pre-wrap} .fline{margin-top:2px;font-size:11px;color:#555}
    .foot{margin-top:28px;display:flex;justify-content:space-between}
    .sign{width:45%;text-align:center;border-top:1px solid #999;padding-top:4px;color:#555}
    .sign .who{margin-top:18px;color:#1a1a1a;font-weight:600}
  </style></head><body>${body}</body></html>`;
}

// Company/seller identity header block — the caller's tenant printed on the top-left of every document.
export interface DocParty { name: string; address?: string | null; tax_id?: string | null; branch_label?: string | null; phone?: string | null; email?: string | null; logo_url?: string | null }

// `opts` lets a no-code A4 template (common/a4-template.ts) toggle the seller address / tax-id lines and
// inject a logo + header note. For a fiscal document the normalize step forces the toggles on, so a template
// can never drop a legally-mandatory seller-identity line here.
export function sellerHeaderHtml(
  p: DocParty,
  opts: { showAddress?: boolean; showTaxId?: boolean; logoHtml?: string; headerNoteHtml?: string } = {},
): string {
  const showAddress = opts.showAddress !== false;
  const showTaxId = opts.showTaxId !== false;
  return `<div>
    ${opts.logoHtml ?? ''}
    <div class="t1">${esc(p.name)}</div>
    ${showAddress && p.address ? `<div>${esc(p.address)}</div>` : ''}
    ${showTaxId && p.tax_id ? `<div>เลขประจำตัวผู้เสียภาษีอากร ${esc(formatTaxId(p.tax_id))} &nbsp; (${esc(p.branch_label ?? 'สำนักงานใหญ่')})</div>` : ''}
    ${p.phone ? `<div>โทร. ${esc(p.phone)}</div>` : ''}
    ${opts.headerNoteHtml ?? ''}
  </div>`;
}

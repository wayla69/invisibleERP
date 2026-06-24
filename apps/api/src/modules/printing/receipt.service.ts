import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { custPosSales, custPosItems, tenants } from '../../database/schema';

const n = (x: any) => Number(x) || 0;
const baht = (x: any) => n(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Attribute-context encode: also neutralise the quotes that could close an attribute (XSS via e.g. logo src).
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export type ReceiptLang = 'th' | 'en' | 'both';

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
};

// Renders a customer receipt for a sale into a normalized data object, an HTML document (for browser/email
// print) and an ESC/POS byte string (for thermal printers). A receipt is a NON-fiscal courtesy document —
// the tax invoice (tax-docs) is the fiscal record — so this never posts to the ledger.
@Injectable()
export class ReceiptService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async loadData(saleNo: string, opts?: { isCopy?: boolean; taxInvoiceNo?: string | null; lang?: ReceiptLang }): Promise<ReceiptData> {
    const db = this.db as any;
    const [sale] = await db.select().from(custPosSales).where(eq(custPosSales.saleNo, saleNo)).limit(1);
    if (!sale) throw new NotFoundException({ code: 'SALE_NOT_FOUND', message: 'Sale not found', messageTh: 'ไม่พบรายการขาย' });
    const lines = await db.select().from(custPosItems).where(eq(custPosItems.saleId, Number(sale.id)));
    let seller: any = null;
    if (sale.tenantId != null) [seller] = await db.select().from(tenants).where(eq(tenants.id, Number(sale.tenantId))).limit(1);
    const addr = seller ? [seller.addressLine1, seller.addressLine2, seller.subDistrict, seller.district, seller.province, seller.postalCode].filter(Boolean).join(' ') : '';
    // language: explicit override > tenant default > th
    const lang: ReceiptLang = opts?.lang ?? ((seller?.defaultLanguage === 'en' ? 'en' : 'th'));
    return {
      sale_no: sale.saleNo,
      date: sale.saleDate ?? null,
      is_copy: !!opts?.isCopy,
      lang,
      seller: {
        name: seller?.name ?? 'ร้านค้า',
        legal_name: seller?.legalName ?? null,
        branch_label: seller?.branchLabelTh ?? null,
        tax_id: seller?.taxId ?? null,
        address: addr || null,
        vat_registered: !!seller?.vatRegistered,
        logo_url: seller?.logoUrl ?? null,
        tagline: seller?.tagline ?? null,
        show_logo: (seller?.brandingPrefs?.show_logo_on_receipt) !== false, // default on when a logo is set
      },
      items: lines.map((l: any) => ({ description: l.itemDescription ?? l.itemId ?? '', qty: n(l.qty), unit_price: n(l.unitPrice), amount: n(l.amount) })),
      subtotal: n(sale.subtotal),
      discount: n(sale.discount),
      vat: n(sale.taxAmount),
      total: n(sale.total),
      tip: n(sale.tip),
      payment_method: sale.paymentMethod ?? 'Cash',
      tax_invoice_no: opts?.taxInvoiceNo ?? null,
      promptpay_id: seller?.promptpayId ?? null,
    };
  }

  // Self-consistency tie-out: a receipt must reconcile to its fiscal sale record (header total = Σ line +
  // VAT − discount + tip). Drives the new REST-10 control (receipt ↔ fiscal-journal tie-out).
  tieOut(d: ReceiptData) {
    const lineSum = Math.round(d.items.reduce((a, l) => a + l.amount, 0) * 100) / 100;
    const expected = Math.round((lineSum - d.discount + d.vat + d.tip) * 100) / 100;
    const matched = Math.abs(expected - Math.round((d.total + d.tip) * 100) / 100) < 0.01;
    return { sale_no: d.sale_no, line_sum: lineSum, discount: d.discount, vat: d.vat, tip: d.tip, total: d.total, matched };
  }

  html(d: ReceiptData): string {
    const t = labels(d.lang);
    const htmlLang = d.lang === 'en' ? 'en' : 'th';
    const rows = d.items.map((l) => `<tr><td>${esc(l.description)}</td><td class="q">${l.qty}</td><td class="m">${baht(l.amount)}</td></tr>`).join('');
    const copy = d.is_copy ? `<div class="copy">${esc(t.copy)}</div>` : '';
    const vatLine = d.seller.vat_registered ? `<tr><td colspan="2">${esc(t.vat)}</td><td class="m">${baht(d.vat)}</td></tr>` : '';
    const tipLine = d.tip > 0 ? `<tr><td colspan="2">${esc(t.tip)}</td><td class="m">${baht(d.tip)}</td></tr>` : '';
    const inv = d.tax_invoice_no ? `<div class="muted">${esc(t.taxInv)} ${esc(d.tax_invoice_no)}</div>` : '';
    return `<!doctype html><html lang="${htmlLang}"><head><meta charset="utf-8"><title>${esc(t.receipt)} ${esc(d.sale_no)}</title>
<style>@page{size:80mm auto;margin:4mm}body{font-family:'TH Sarabun New',Tahoma,monospace;width:72mm;margin:0 auto;font-size:13px;color:#000}
h1{font-size:16px;text-align:center;margin:0}.muted{color:#444;font-size:11px;text-align:center}.copy{text-align:center;font-weight:bold;border:1px dashed #000;margin:4px 0;padding:2px}
.logo{display:block;max-height:48px;max-width:60mm;margin:0 auto 4px}.tagline{text-align:center;font-size:11px;font-style:italic;color:#333}
table{width:100%;border-collapse:collapse;margin-top:6px}td{padding:1px 0;vertical-align:top}.q{text-align:center;width:24px}.m{text-align:right;width:64px}
.sep{border-top:1px dashed #000}.tot td{font-weight:bold}.foot{text-align:center;margin-top:8px;font-size:11px}@media print{button{display:none}}</style></head>
<body onload="if(location.search.indexOf('print')>=0)window.print()">
${d.seller.logo_url && d.seller.show_logo ? `<img class="logo" src="${escAttr(d.seller.logo_url)}" alt="">` : ''}
<h1>${esc(d.seller.legal_name || d.seller.name)}</h1>
${d.seller.tagline ? `<div class="tagline">${esc(d.seller.tagline)}</div>` : ''}
${d.seller.branch_label ? `<div class="muted">${esc(d.seller.branch_label)}</div>` : ''}
${d.seller.address ? `<div class="muted">${esc(d.seller.address)}</div>` : ''}
${d.seller.tax_id ? `<div class="muted">${esc(t.taxId)} ${esc(d.seller.tax_id)}</div>` : ''}
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
<div class="foot">${esc(t.thanks)}</div>
</body></html>`;
  }

  // Minimal ESC/POS: init, centered header, left body, right-aligned totals, feed + full cut.
  escpos(d: ReceiptData): string {
    const t = labels(d.lang);
    const ESC = '\x1b', GS = '\x1d';
    const init = ESC + '@';
    const center = ESC + 'a' + '\x01', left = ESC + 'a' + '\x00';
    const boldOn = ESC + 'E' + '\x01', boldOff = ESC + 'E' + '\x00';
    const cut = GS + 'V' + '\x42' + '\x00';
    const W = 42; // 80mm @ Font A
    const row = (l: string, r: string) => { const pad = Math.max(1, W - l.length - r.length); return l + ' '.repeat(pad) + r + '\n'; };
    let s = init + center + boldOn + (d.seller.legal_name || d.seller.name) + '\n' + boldOff;
    if (d.seller.branch_label) s += d.seller.branch_label + '\n';
    if (d.seller.address) s += d.seller.address + '\n';
    if (d.seller.tax_id) s += t.taxId + ' ' + d.seller.tax_id + '\n';
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
    s += '\n' + center + t.thanks + '\n\n\n' + cut;
    return s;
  }
}

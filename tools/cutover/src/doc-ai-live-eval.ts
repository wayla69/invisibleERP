/**
 * Doc-AI VISION accuracy eval — OPT-IN, live, NOT a CI gate.
 *
 * CI runs keyless, so the vision path (Claude reading a scanned invoice image) has no automated accuracy
 * measurement at all — the deterministic paths are covered by `ext`/`match`/vitest, but "how well does
 * the model actually read a Thai tax invoice" was unmeasured. This script closes that: it renders
 * synthetic invoice images (Thai พ.ศ. dates + 7% VAT + 13-digit tax id, EN, USD, a rotated/noisy photo
 * variant, a many-line invoice) with the pre-installed Chromium, runs the REAL
 * `DocAiService.extractInvoiceDocument` against the live model, and scores per-field + line accuracy
 * against embedded ground truth.
 *
 * Run:   ANTHROPIC_API_KEY=… pnpm --filter @ierp/cutover doc-ai-live-eval
 * With no key it prints SKIPPED and exits 0 (same convention as ai-eval's live layer).
 * DOC_AI_EVAL_MIN=<0..1> optionally turns the overall field score into a local gate.
 * DOC_AI_EVAL_CHROMIUM=<path> overrides the Chromium executable (defaults to the sandbox install under
 * /opt/pw-browsers/chromium-NNNN/chrome-linux/chrome, else Playwright's own resolution).
 */
import { readdirSync, existsSync } from 'node:fs';

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
if (!KEY) {
  console.log('SKIPPED — no ANTHROPIC_API_KEY set (this is the opt-in live vision eval; CI stays keyless).');
  process.exit(0);
}

interface Truth {
  vendor_name: string;
  vendor_tax_id: string | null;
  invoice_no: string;
  invoice_date: string; // CE YYYY-MM-DD
  amount: number;
  currency: string;
  po_no: string | null;
  line_count: number;
  line_sum: number | null; // Σ line amounts (pre-VAT) — null = don't score
}

interface Fixture { name: string; html: string; truth: Truth }

const pageWrap = (body: string, extraCss = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font-family: 'Noto Sans Thai', 'TH Sarabun New', Tahoma, sans-serif; margin: 24px; color: #111; width: 720px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  td, th { border: 1px solid #999; padding: 4px 8px; font-size: 14px; }
  h1 { font-size: 20px; } .r { text-align: right; } .meta { font-size: 14px; }
  ${extraCss}
</style></head><body>${body}</body></html>`;

const thaiLines = [
  { d: 'ข้าวหอมมะลิ 5 กก.', q: 10, p: 250, a: 2500 },
  { d: 'น้ำมันพืช 1 ลิตร', q: 24, p: 55, a: 1320 },
  { d: 'น้ำตาลทราย 1 กก.', q: 30, p: 28, a: 840 },
  { d: 'ซอสปรุงรส 700 มล.', q: 12, p: 45, a: 540 },
];
const thaiSub = thaiLines.reduce((s, l) => s + l.a, 0); // 5200
const thaiVat = Math.round(thaiSub * 0.07 * 100) / 100; // 364
const thaiBody = `
  <h1>ใบกำกับภาษี / ใบเสร็จรับเงิน</h1>
  <div class="meta">บริษัท สยามอาหาร จำกัด<br>เลขประจำตัวผู้เสียภาษี 0105543001231<br>
  เลขที่ SIA-2569-0042 · วันที่ 18/07/2569 (พ.ศ.)<br>อ้างอิงใบสั่งซื้อ PO-20260701-012</div>
  <table><tr><th>รายการ</th><th class="r">จำนวน</th><th class="r">หน่วยละ</th><th class="r">จำนวนเงิน</th></tr>
  ${thaiLines.map((l) => `<tr><td>${l.d}</td><td class="r">${l.q}</td><td class="r">${l.p.toFixed(2)}</td><td class="r">${l.a.toFixed(2)}</td></tr>`).join('')}
  </table>
  <p class="r">รวมเงิน ${thaiSub.toFixed(2)} · ภาษีมูลค่าเพิ่ม 7% ${thaiVat.toFixed(2)}<br><b>รวมทั้งสิ้น ${(thaiSub + thaiVat).toFixed(2)} บาท</b></p>`;

const manyLines = Array.from({ length: 8 }, (_, i) => ({ d: `Part #A-${100 + i}`, q: i + 1, p: 40 + i * 5, a: (i + 1) * (40 + i * 5) }));
const manySub = manyLines.reduce((s, l) => s + l.a, 0);

const FIXTURES: Fixture[] = [
  {
    name: 'thai-tax-invoice (พ.ศ. date, 7% VAT, 13-digit tax id, PO ref)',
    html: pageWrap(thaiBody),
    truth: { vendor_name: 'สยามอาหาร', vendor_tax_id: '0105543001231', invoice_no: 'SIA-2569-0042', invoice_date: '2026-07-18', amount: thaiSub + thaiVat, currency: 'THB', po_no: 'PO-20260701-012', line_count: 4, line_sum: thaiSub },
  },
  {
    name: 'english-invoice',
    html: pageWrap(`<h1>TAX INVOICE</h1><div class="meta">ACME Supplies Co., Ltd.<br>Tax ID 0105536112233<br>
      Invoice No. INV-2026-0815 · Date 2026-07-15</div>
      <table><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit</th><th class="r">Amount</th></tr>
      <tr><td>Industrial gloves (box)</td><td class="r">20</td><td class="r">120.00</td><td class="r">2,400.00</td></tr>
      <tr><td>Safety goggles</td><td class="r">10</td><td class="r">85.00</td><td class="r">850.00</td></tr></table>
      <p class="r">Subtotal 3,250.00 · VAT 7% 227.50<br><b>Grand Total 3,477.50 THB</b></p>`),
    truth: { vendor_name: 'ACME', vendor_tax_id: '0105536112233', invoice_no: 'INV-2026-0815', invoice_date: '2026-07-15', amount: 3477.5, currency: 'THB', po_no: null, line_count: 2, line_sum: 3250 },
  },
  {
    name: 'usd-invoice',
    html: pageWrap(`<h1>INVOICE</h1><div class="meta">Globex Trading Pte. Ltd. (Singapore)<br>
      Invoice GLX-889 · Date 2026-06-30 · Currency: USD</div>
      <table><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit</th><th class="r">Amount</th></tr>
      <tr><td>Controller board X9</td><td class="r">4</td><td class="r">310.00</td><td class="r">1,240.00</td></tr></table>
      <p class="r"><b>Total USD 1,240.00</b></p>`),
    truth: { vendor_name: 'Globex', vendor_tax_id: null, invoice_no: 'GLX-889', invoice_date: '2026-06-30', amount: 1240, currency: 'USD', po_no: null, line_count: 1, line_sum: 1240 },
  },
  {
    name: 'thai-photo-variant (rotated + noisy background)',
    html: pageWrap(`<div style="transform: rotate(-3.5deg); box-shadow: 0 2px 14px #0006; background:#fffdf6; padding:16px;">${thaiBody}</div>`,
      'body { background: repeating-linear-gradient(45deg, #cfc9bd, #cfc9bd 6px, #bdb7ab 6px, #bdb7ab 12px); }'),
    truth: { vendor_name: 'สยามอาหาร', vendor_tax_id: '0105543001231', invoice_no: 'SIA-2569-0042', invoice_date: '2026-07-18', amount: thaiSub + thaiVat, currency: 'THB', po_no: 'PO-20260701-012', line_count: 4, line_sum: thaiSub },
  },
  {
    name: 'many-line-invoice (8 lines)',
    html: pageWrap(`<h1>INVOICE</h1><div class="meta">Partsmaster Ltd.<br>Invoice PM-5501 · Date 2026-07-01</div>
      <table><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit</th><th class="r">Amount</th></tr>
      ${manyLines.map((l) => `<tr><td>${l.d}</td><td class="r">${l.q}</td><td class="r">${l.p.toFixed(2)}</td><td class="r">${l.a.toFixed(2)}</td></tr>`).join('')}
      </table><p class="r"><b>Grand Total ${manySub.toFixed(2)} THB</b></p>`),
    truth: { vendor_name: 'Partsmaster', vendor_tax_id: null, invoice_no: 'PM-5501', invoice_date: '2026-07-01', amount: manySub, currency: 'THB', po_no: null, line_count: 8, line_sum: manySub },
  },
];

function chromiumExecutable(): string | undefined {
  const env = (process.env.DOC_AI_EVAL_CHROMIUM || '').trim();
  if (env) return env;
  const roots = ['/opt/pw-browsers'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const dir of readdirSync(root)) {
      if (/^chromium-\d+$/.test(dir)) {
        const p = `${root}/${dir}/chrome-linux/chrome`;
        if (existsSync(p)) return p;
      }
    }
  }
  return undefined; // let playwright-core resolve from its own registry
}

async function main() {
  const { chromium } = await import('playwright-core');
  const { DocAiService } = await import('../../../apps/api/dist/modules/doc-ai/doc-ai.service');
  const svc = new DocAiService(undefined);
  const user = { username: 'eval', role: 'Admin' } as any;

  const browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable() });
  const page = await browser.newPage({ viewport: { width: 820, height: 1100 }, deviceScaleFactor: 2 });

  const rows: { name: string; score: number; fields: number; total: number; detail: string[] }[] = [];
  for (const fx of FIXTURES) {
    await page.setContent(fx.html, { waitUntil: 'networkidle' });
    const png = (await page.screenshot({ fullPage: true, type: 'png' })).toString('base64');
    const r = await svc.extractInvoiceDocument({ media_type: 'image/png', data: png }, user);
    const f = r.fields ?? {};
    const detail: string[] = [];
    let got = 0;
    let total = 0;
    const check = (label: string, ok: boolean, gotV: unknown, want: unknown) => {
      total++;
      if (ok) got++;
      else detail.push(`✗ ${label}: got ${JSON.stringify(gotV)} want ${JSON.stringify(want)}`);
    };
    check('vendor_name', typeof f.vendor_name === 'string' && f.vendor_name.includes(fx.truth.vendor_name), f.vendor_name, `*${fx.truth.vendor_name}*`);
    check('vendor_tax_id', (f.vendor_tax_id ?? null) === fx.truth.vendor_tax_id, f.vendor_tax_id, fx.truth.vendor_tax_id);
    check('invoice_no', f.invoice_no === fx.truth.invoice_no, f.invoice_no, fx.truth.invoice_no);
    check('invoice_date (CE)', f.invoice_date === fx.truth.invoice_date, f.invoice_date, fx.truth.invoice_date);
    check('amount', typeof f.amount === 'number' && Math.abs(f.amount - fx.truth.amount) < 0.01, f.amount, fx.truth.amount);
    check('currency', f.currency === fx.truth.currency, f.currency, fx.truth.currency);
    check('po_no', (f.po_no ?? null) === fx.truth.po_no, f.po_no, fx.truth.po_no);
    const lines = Array.isArray(f.lines) ? f.lines : [];
    check('line_count', lines.length === fx.truth.line_count, lines.length, fx.truth.line_count);
    if (fx.truth.line_sum != null) {
      const sum = lines.reduce((s: number, l: any) => s + (Number(l?.amount) || 0), 0);
      check('line_sum ±1%', Math.abs(sum - fx.truth.line_sum) <= fx.truth.line_sum * 0.01, sum, fx.truth.line_sum);
    }
    rows.push({ name: fx.name, score: got / total, fields: got, total, detail });
    if (r.source !== 'ai') detail.push(`✗ source=${r.source} (expected 'ai')`);
  }
  await browser.close();

  console.log('\n── Doc-AI vision accuracy (live model) ──');
  let g = 0;
  let t = 0;
  for (const r of rows) {
    g += r.fields; t += r.total;
    console.log(`  ${r.score === 1 ? '✅' : r.score >= 0.75 ? '🟡' : '❌'} ${(r.score * 100).toFixed(0).padStart(3)}% (${r.fields}/${r.total})  ${r.name}`);
    for (const d of r.detail) console.log(`        ${d}`);
  }
  const overall = g / t;
  console.log(`\n  Overall field accuracy: ${(overall * 100).toFixed(1)}% (${g}/${t})`);

  const min = Number(process.env.DOC_AI_EVAL_MIN || '');
  if (Number.isFinite(min) && min > 0 && overall < min) {
    console.log(`\n❌ below DOC_AI_EVAL_MIN=${min}`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

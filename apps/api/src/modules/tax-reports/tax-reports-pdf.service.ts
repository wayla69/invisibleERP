import { Injectable, Logger } from '@nestjs/common';

const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const money = (v: any) => Number(v ?? 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// รายงานภาษี / แบบยื่นสรรพากร → HTML (Sarabun) → PDF ผ่าน playwright-core; Chromium ไม่พร้อม → คืน null ให้ fallback HTML
@Injectable()
export class TaxReportsPdfService {
  private readonly logger = new Logger(TaxReportsPdfService.name);

  async renderHtmlToPdf(html: string): Promise<Buffer | null> {
    let browser: any = null;
    try {
      const { chromium } = await import('playwright-core');
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle' });
      const pdf = await page.pdf({ format: 'A4', landscape: true, printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '10mm', right: '10mm' } });
      return Buffer.from(pdf);
    } catch (err) {
      this.logger.warn(`Chromium unavailable, falling back to HTML: ${(err as Error)?.message ?? err}`);
      return null;
    } finally { if (browser) { try { await browser.close(); } catch { /* ignore */ } } }
  }

  private wrap(title: string, body: string, sub = ''): string {
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><style>
      *{font-family:'Sarabun','TH Sarabun New',sans-serif;box-sizing:border-box}
      body{margin:0;color:#1a1a1a;font-size:13px}
      h1{font-size:18px;margin:0 0 2px;text-align:center}
      .sub{text-align:center;color:#555;margin:0 0 12px;font-size:12px}
      table{width:100%;border-collapse:collapse;margin-top:8px}
      th,td{border:1px solid #999;padding:5px 7px;text-align:left}
      th{background:#1E3C72;color:#fff;font-weight:600;font-size:12px}
      td.num,th.num{text-align:right}
      tr.total td{font-weight:700;background:#eef2f9}
      .form-row{display:flex;justify-content:space-between;padding:6px 10px;border-bottom:1px solid #ddd;max-width:520px;margin:0 auto}
      .form-row.grand{font-weight:700;border-top:2px solid #1E3C72;border-bottom:none}
      .meta{margin-top:14px;color:#666;font-size:11px;text-align:center}
    </style></head><body><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}${body}</body></html>`;
  }

  outputVatHtml(d: any): string {
    const rows = d.rows.map((r: any, i: number) => `<tr><td>${i + 1}</td><td>${esc(r.date)}</td><td>${esc(r.doc_no)}</td><td>${esc(r.buyer_name)}</td><td>${esc(r.buyer_tax_id)}</td><td class="num">${money(r.value)}</td><td class="num">${money(r.vat)}</td></tr>`).join('');
    const body = `<table><thead><tr><th>#</th><th>วันที่</th><th>เลขที่เอกสาร</th><th>ชื่อผู้ซื้อ</th><th>เลขผู้เสียภาษี</th><th class="num">มูลค่า</th><th class="num">ภาษีมูลค่าเพิ่ม</th></tr></thead>
      <tbody>${rows}<tr class="total"><td colspan="5">รวม (${d.totals.count} รายการ)</td><td class="num">${money(d.totals.value)}</td><td class="num">${money(d.totals.vat)}</td></tr></tbody></table>`;
    return this.wrap('รายงานภาษีขาย', body, `ภาษีขาย ประจำเดือน ${d.period}`);
  }

  inputVatHtml(d: any): string {
    const rows = d.rows.map((r: any, i: number) => `<tr><td>${i + 1}</td><td>${esc(r.date)}</td><td>${esc(r.doc_no)}</td><td>${esc(r.invoice_no ?? '-')}</td><td>${esc(r.vendor_name ?? '-')}</td><td class="num">${money(r.base)}</td><td class="num">${money(r.vat)}</td></tr>`).join('');
    const body = `<table><thead><tr><th>#</th><th>วันที่</th><th>เลขที่</th><th>เลขที่ใบกำกับ</th><th>ผู้ขาย</th><th class="num">ฐานภาษี</th><th class="num">ภาษีซื้อ</th></tr></thead>
      <tbody>${rows}<tr class="total"><td colspan="5">รวม (${d.totals.count} รายการ)</td><td class="num">${money(d.totals.base)}</td><td class="num">${money(d.totals.vat)}</td></tr></tbody></table>`;
    return this.wrap('รายงานภาษีซื้อ', body, `ภาษีซื้อ ประจำเดือน ${d.period}`);
  }

  pp30Html(d: any): string {
    const f = d.form;
    const body = `<div>
      <div class="form-row"><span>ยอดขายที่ต้องเสียภาษี</span><span>${money(f.sales_taxable)}</span></div>
      <div class="form-row"><span>ภาษีขาย</span><span>${money(f.output_vat)}</span></div>
      <div class="form-row"><span>ยอดซื้อที่มีสิทธิหักภาษี</span><span>${money(f.purchases)}</span></div>
      <div class="form-row"><span>ภาษีซื้อ</span><span>${money(f.input_vat)}</span></div>
      <div class="form-row grand"><span>ภาษีที่ต้องชำระ</span><span>${money(f.vat_payable)}</span></div>
      <div class="form-row grand"><span>ภาษีชำระเกิน (เครดิตยกไป)</span><span>${money(f.vat_credit_carry_forward)}</span></div>
      <div class="meta">กระทบยอดบัญชี 2100: เคลื่อนไหว ${money(d.reconciliation.gl_net_movement)} · ตรงกับรายงาน: ${d.reconciliation.tied ? 'ใช่' : 'ไม่'}<br>${esc(d.deadline_note)} (กำหนด ${esc(d.deadline)})</div>
    </div>`;
    return this.wrap('แบบ ภ.พ.30 — ภาษีมูลค่าเพิ่ม', body, `ประจำเดือน ${d.period}`);
  }

  pndHtml(d: any): string {
    const rows = d.rows.map((r: any, i: number) => `<tr><td>${i + 1}</td><td>${esc(r.payee_tax_id ?? '-')}</td><td>${esc(r.payee_name)}</td><td>${esc(r.income_type)}</td><td class="num">${money(r.amount_paid)}</td><td class="num">${money(r.rate)}%</td><td class="num">${money(r.tax_withheld)}</td></tr>`).join('');
    const body = `<table><thead><tr><th>ลำดับ</th><th>เลขประจำตัวผู้เสียภาษี</th><th>ชื่อผู้ถูกหัก</th><th>ประเภทเงินได้</th><th class="num">จำนวนเงิน</th><th class="num">อัตรา</th><th class="num">ภาษีที่หัก</th></tr></thead>
      <tbody>${rows}<tr class="total"><td colspan="4">รวม (${d.totals.count} ราย)</td><td class="num">${money(d.totals.amount_paid)}</td><td></td><td class="num">${money(d.totals.tax_withheld)}</td></tr></tbody></table>
      <div class="meta">${esc(d.deadline_note)} (กำหนด ${esc(d.deadline)})</div>`;
    return this.wrap(`แบบ ${esc(d.pnd_label)}`, body, `ประจำเดือน ${d.period}`);
  }
}

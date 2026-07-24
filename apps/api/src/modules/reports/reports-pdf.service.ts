import { Injectable } from '@nestjs/common';
import { n } from '../../database/queries';
import { PdfRenderer } from '../pdf/pdf-renderer.service';

const VAT_RATE = 0.07;

// แปลง HTML → PDF (Sarabun สำหรับภาษาไทย). Rendering is delegated to the shared PdfRenderer (external-service
// offload or pooled Chromium); if PDF rendering is unavailable it returns null → caller falls back to HTML.
@Injectable()
export class ReportPdfService {
  constructor(private readonly pdf: PdfRenderer) {}

  renderHtmlToPdf(html: string): Promise<Buffer | null> {
    return this.pdf.render(html, { format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } });
  }

  // ── HTML template builders ──────────────────────────────────────────

  // ใบยืนยันการสั่งขาย
  salesConfirmationHtml(order: any, lines: any[], tenant: any): string {
    const rows = lines
      .map(
        (l, i) => `
        <tr>
          <td class="c">${i + 1}</td>
          <td>${esc(l.itemId ?? l.item_id ?? '')}</td>
          <td>${esc(l.itemDescription ?? l.item_description ?? '')}</td>
          <td class="r">${fmtQty(n(l.orderQty ?? l.order_qty))}</td>
          <td class="c">${esc(l.stockUom ?? l.stock_uom ?? l.uom ?? '')}</td>
          <td class="r">${fmtMoney(n(l.unitPrice ?? l.unit_price))}</td>
          <td class="r">${fmtMoney(n(l.totalPrice ?? l.total_price))}</td>
        </tr>`,
      )
      .join('');

    const subtotal = lines.reduce((a, l) => a + n(l.totalPrice ?? l.total_price), 0);
    const vat = round2(subtotal * VAT_RATE);
    const grand = round2(subtotal + vat);

    return this.wrap(
      'ใบยืนยันการสั่งขาย / Sales Confirmation',
      `
      ${this.partyBlock('ลูกค้า / Customer', tenant)}
      <table class="meta">
        <tr><td class="lbl">เลขที่ใบสั่งขาย / Order No</td><td>${esc(order.orderNo ?? order.order_no ?? '')}</td></tr>
        <tr><td class="lbl">วันที่ / Date</td><td>${esc(order.orderDate ?? order.order_date ?? '')}</td></tr>
        <tr><td class="lbl">สถานะ / Status</td><td>${esc(order.status ?? '')}</td></tr>
      </table>
      <table class="grid">
        <thead>
          <tr>
            <th class="c">ลำดับ</th><th>รหัสสินค้า</th><th>รายการ</th>
            <th class="r">จำนวน</th><th class="c">หน่วย</th>
            <th class="r">ราคา/หน่วย</th><th class="r">จำนวนเงิน</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${this.totalsBlock([
        ['รวมเป็นเงิน / Subtotal', subtotal],
        ['ภาษีมูลค่าเพิ่ม 7% / VAT', vat],
        ['ยอดสุทธิ / Grand Total', grand],
      ])}
      `,
    );
  }

  // ใบกำกับภาษี
  taxInvoiceHtml(order: any, lines: any[], tenant: any): string {
    const rows = lines
      .map(
        (l, i) => `
        <tr>
          <td class="c">${i + 1}</td>
          <td>${esc(l.itemDescription ?? l.item_description ?? '')}</td>
          <td class="r">${fmtQty(n(l.orderQty ?? l.order_qty ?? l.qty))}</td>
          <td class="r">${fmtMoney(n(l.unitPrice ?? l.unit_price))}</td>
          <td class="r">${fmtMoney(n(l.totalPrice ?? l.total_price ?? l.amount))}</td>
        </tr>`,
      )
      .join('');

    const subtotal = lines.reduce((a, l) => a + n(l.totalPrice ?? l.total_price ?? l.amount), 0);
    const vat = round2(subtotal * VAT_RATE);
    const grand = round2(subtotal + vat);

    return this.wrap(
      'ใบกำกับภาษี / Tax Invoice',
      `
      ${this.partyBlock('ลูกค้า / Customer', tenant)}
      <table class="meta">
        <tr><td class="lbl">เลขที่ / No</td><td>${esc(order.invoiceNo ?? order.orderNo ?? order.order_no ?? '')}</td></tr>
        <tr><td class="lbl">วันที่ / Date</td><td>${esc(order.invoiceDate ?? order.orderDate ?? order.order_date ?? '')}</td></tr>
        <tr><td class="lbl">เลขประจำตัวผู้เสียภาษี / Tax ID</td><td>${esc(tenant?.taxId ?? tenant?.tax_id ?? '-')}</td></tr>
      </table>
      <table class="grid">
        <thead>
          <tr><th class="c">ลำดับ</th><th>รายการ</th><th class="r">จำนวน</th><th class="r">ราคา/หน่วย</th><th class="r">จำนวนเงิน</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${this.totalsBlock([
        ['มูลค่าสินค้า / Subtotal', subtotal],
        ['ภาษีมูลค่าเพิ่ม 7% / VAT', vat],
        ['รวมทั้งสิ้น / Total', grand],
      ])}
      `,
    );
  }

  // ใบเสร็จรับเงิน
  receiptHtml(receipt: any, tenant: any): string {
    const amount = n(receipt.amount);
    return this.wrap(
      'ใบเสร็จรับเงิน / Receipt',
      `
      ${this.partyBlock('ลูกค้า / Customer', tenant)}
      <table class="meta">
        <tr><td class="lbl">เลขที่ใบเสร็จ / Receipt No</td><td>${esc(receipt.receiptNo ?? receipt.receipt_no ?? '')}</td></tr>
        <tr><td class="lbl">วันที่ / Date</td><td>${esc(receipt.receiptDate ?? receipt.receipt_date ?? '')}</td></tr>
        <tr><td class="lbl">อ้างอิงใบแจ้งหนี้ / Invoice</td><td>${esc(receipt.invoiceNo ?? receipt.invoice_no ?? '-')}</td></tr>
        <tr><td class="lbl">วิธีชำระ / Method</td><td>${esc(receipt.method ?? '-')}</td></tr>
      </table>
      ${this.totalsBlock([['จำนวนเงินที่รับ / Amount Received', amount]])}
      <p class="words">(${esc(bahtWords(amount))})</p>
      `,
    );
  }

  // ใบแจ้งยอด (statement of account)
  statementHtml(tenant: any, invoices: any[]): string {
    const rows = invoices
      .map(
        (inv) => `
        <tr>
          <td>${esc(inv.invoiceNo ?? inv.invoice_no ?? '')}</td>
          <td class="c">${esc(inv.invoiceDate ?? inv.invoice_date ?? '')}</td>
          <td class="c">${esc(inv.dueDate ?? inv.due_date ?? '')}</td>
          <td class="r">${fmtMoney(n(inv.amount))}</td>
          <td class="r">${fmtMoney(n(inv.outstanding ?? inv.Outstanding_Amount ?? inv.amount))}</td>
          <td class="c">${esc(inv.status ?? '')}</td>
        </tr>`,
      )
      .join('');

    const totalOut = invoices.reduce((a, inv) => a + n(inv.outstanding ?? inv.Outstanding_Amount ?? inv.amount), 0);

    return this.wrap(
      'ใบแจ้งยอด / Statement of Account',
      `
      ${this.partyBlock('ลูกค้า / Customer', tenant)}
      <table class="grid">
        <thead>
          <tr><th>เลขที่ใบแจ้งหนี้</th><th class="c">วันที่</th><th class="c">ครบกำหนด</th><th class="r">จำนวนเงิน</th><th class="r">คงค้าง</th><th class="c">สถานะ</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${this.totalsBlock([['ยอดคงค้างรวม / Total Outstanding', round2(totalOut)]])}
      `,
    );
  }

  // ── Statutory financial-statement PACK (P9) ──────────────────────────
  // Renders the assembled pack from StatutoryFsService.statementPack (BS + PL + SOCE + optional notes) as one
  // formatted A4 document: Thai-forward bilingual captions, a current/prior comparative column, accounting-style
  // negatives (parentheses), indentation + bold on subtotals, the P8 KPI strip per statement, and a page break
  // before each primary statement. Pure presentation — the numbers come straight from the pack.
  financialStatementPackHtml(pack: any): string {
    const comp = !!pack.comparative;
    const money = (x: number | null | undefined) => (x == null ? '' : fmtAmt(n(x)));
    const curLbl = fmtDate(pack?.period?.as_of);
    const priLbl = fmtDate(pack?.period?.prior_as_of);
    const co = pack?.company;

    // one statement table (BS/PL) from render rows
    const stmtTable = (rows: any[]) => {
      const body = (rows ?? []).map((r) => {
        const name = esc(r.label_th ?? r.label ?? r.account_name ?? r.account_code ?? '');
        const indent = 8 + (Number(r.level ?? 0)) * 16;
        const cls = r.is_subtotal ? ' class="sub"' : (r.is_account ? ' class="acct"' : '');
        const prior = comp ? `<td class="r">${money(r.prior)}</td>` : '';
        return `<tr${cls}><td style="padding-left:${indent}px">${name}</td><td class="r">${money(r.current)}</td>${prior}</tr>`;
      }).join('');
      return `<table class="stmt"><thead><tr><th>รายการ / Item</th><th class="r">${esc(curLbl)}</th>${comp ? `<th class="r">${esc(priLbl)}</th>` : ''}</tr></thead><tbody>${body}</tbody></table>`;
    };

    // the P8 KPI strip for a statement
    const kpiStrip = (kpis: any[]) => {
      if (!kpis?.length) return '';
      const chips = kpis.map((k) => {
        const v = k.format === 'pct' ? `${(n(k.value) * 100).toFixed(1)}%` : `${n(k.value).toFixed(2)}×`;
        return `<span class="kpi"><b>${esc(k.label_th ?? k.label)}</b> ${v}</span>`;
      }).join('');
      return `<div class="kpis">${chips}</div>`;
    };

    // SOCE matrix
    const soce = pack?.changes_in_equity;
    const soceTable = () => {
      if (!soce?.components?.length) return '';
      const rows = soce.components.map((c: any) => `<tr><td>${esc(c.account_name)} <span class="muted">${esc(c.account_code)}</span></td><td class="r">${money(c.opening)}</td><td class="r">${money(c.movements)}</td><td class="r">${money(c.profit)}</td><td class="r">${money(c.closing)}</td></tr>`).join('');
      const t = soce.totals;
      return `<table class="stmt"><thead><tr><th>องค์ประกอบ / Component</th><th class="r">ยอดต้นงวด</th><th class="r">การเปลี่ยนแปลง</th><th class="r">กำไรงวดนี้</th><th class="r">ยอดปลายงวด</th></tr></thead>`
        + `<tbody>${rows}<tr class="sub"><td>รวม / Total</td><td class="r">${money(t.opening)}</td><td class="r">${money(t.movements)}</td><td class="r">${money(t.profit)}</td><td class="r">${money(t.closing)}</td></tr></tbody></table>`;
    };

    // TFRS 15 revenue disaggregation (P10): categories grouped by timing of transfer, tying to revenue.
    const disaggBlock = () => {
      const d = pack?.revenue_disaggregation;
      if (!d?.categories?.length) return '';
      const catRow = (c: any) => `<tr><td>${esc(c.account_name ?? c.account_code)} <span class="muted">${esc(c.account_code)}</span></td><td class="r">${money(c.current)}</td>${comp ? `<td class="r">${money(c.prior)}</td>` : ''}</tr>`;
      const ot = d.categories.filter((c: any) => c.timing === 'over_time');
      const pit = d.categories.filter((c: any) => c.timing === 'point_in_time');
      const band = (label: string, rows: any[], sub: any) => rows.length
        ? `<tr class="band"><td>${label}</td><td class="r">${money(sub.current)}</td>${comp ? `<td class="r">${money(sub.prior)}</td>` : ''}</tr>${rows.map(catRow).join('')}`
        : '';
      const ts = d.timing_summary;
      return `<section class="break">
        <h2>หมายเหตุ: การจำแนกรายได้ (TFRS 15) / Revenue Disaggregation (TFRS 15)</h2>
        ${d.policy ? `<p class="policy">${esc(d.policy.th)} — ${esc(d.policy.en)}</p>` : ''}
        <table class="stmt"><thead><tr><th>ประเภทรายได้ / Category</th><th class="r">${esc(curLbl)}</th>${comp ? `<th class="r">${esc(priLbl)}</th>` : ''}</tr></thead><tbody>
          ${band('รับรู้ตลอดช่วงเวลา / Over time', ot, ts.over_time)}
          ${band('รับรู้ ณ จุดหนึ่ง / Point in time', pit, ts.point_in_time)}
          <tr class="sub"><td>รวมรายได้ / Total revenue</td><td class="r">${money(d.total.current)}</td>${comp ? `<td class="r">${money(d.total.prior)}</td>` : ''}</tr>
        </tbody></table>
      </section>`;
    };

    // Notes (best-effort)
    const notesBlock = () => {
      const notes = pack?.notes?.notes;
      if (!notes?.length) return '';
      const sections = notes.map((nt: any) => {
        const lines = (nt.lines ?? []).map((l: any) => `<tr><td>${esc(l.account_name)} <span class="muted">${esc(l.account_code)}</span></td><td class="r">${money(l.current)}</td>${comp ? `<td class="r">${money(l.prior)}</td>` : ''}</tr>`).join('');
        const policy = nt.policy_text_th || nt.policy_text ? `<p class="policy">${esc(nt.policy_text_th ?? nt.policy_text)}</p>` : '';
        return `<div class="note"><div class="note-h">${esc(nt.number)}. ${esc(nt.title_th ?? nt.title)}</div>${policy}`
          + `<table class="stmt"><tbody>${lines}<tr class="sub"><td>รวม / Total</td><td class="r">${money(nt.total)}</td>${comp ? `<td class="r">${money(nt.prior_total)}</td>` : ''}</tr></tbody></table></div>`;
      }).join('');
      return `<section class="break"><h2>หมายเหตุประกอบงบการเงิน / Notes to the Financial Statements</h2>${sections}</section>`;
    };

    const periodLine = `สำหรับปีสิ้นสุด / For the year ended ${esc(fmtDate(pack?.period?.as_of))}`
      + (comp ? ` (เปรียบเทียบ / comparative ${esc(fmtDate(pack?.period?.prior_as_of))})` : '');

    // GL-29 issuance stamp: reviewed & approved (maker-checker) vs re-review-required vs unaudited.
    const reviewStamp = () => {
      const rv = pack?.review;
      if (rv && rv.figures_changed) {
        return '<div class="rereview">ตัวเลขเปลี่ยนแปลงหลังการอนุมัติ — ต้องสอบทานใหม่ / Figures changed since approval — re-review required</div>';
      }
      if (rv) {
        const by = esc(rv.approved_by ?? '');
        const on = esc(fmtDate(String(rv.approved_at ?? '').slice(0, 10)));
        const prep = rv.prepared_by ? ` · จัดทำโดย/prepared by ${esc(rv.prepared_by)}` : '';
        return `<div class="approved">สอบทานและอนุมัติแล้วโดย/Reviewed &amp; approved by ${by} เมื่อ/on ${on}${prep}</div>`;
      }
      return '<div class="unaudited">ยังไม่ได้ตรวจสอบ — งบเพื่อการบริหาร / Unaudited — management accounts</div>';
    };

    return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Sarabun', sans-serif; color: #1a1a1a; font-size: 12px; margin: 0; }
  .cover { text-align: center; padding: 6px 0 14px; border-bottom: 3px solid #1E3C72; margin-bottom: 14px; }
  .cover .co { font-size: 20px; font-weight: 700; color: #1E3C72; }
  .cover .sub { color: #555; margin-top: 2px; }
  .cover .fs { font-size: 15px; font-weight: 700; margin-top: 8px; }
  .cover .unaudited { display: inline-block; margin-top: 6px; padding: 2px 8px; border: 1px solid #b45309; color: #b45309; border-radius: 4px; font-size: 11px; }
  .cover .approved { display: inline-block; margin-top: 6px; padding: 2px 8px; border: 1px solid #15803d; background: #f0fdf4; color: #15803d; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .cover .rereview { display: inline-block; margin-top: 6px; padding: 2px 8px; border: 1px solid #b91c1c; background: #fef2f2; color: #b91c1c; border-radius: 4px; font-size: 11px; font-weight: 600; }
  h2 { font-size: 14px; color: #1E3C72; border-bottom: 1.5px solid #1E3C72; padding-bottom: 3px; margin: 0 0 8px; }
  section { margin-bottom: 16px; }
  section.break { page-break-before: always; }
  table.stmt { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  table.stmt th { background: #1E3C72; color: #fff; font-weight: 600; padding: 5px 6px; text-align: left; }
  table.stmt td { padding: 3px 6px; border-bottom: 1px solid #eee; }
  table.stmt tr.sub td { font-weight: 700; border-top: 1px solid #1E3C72; background: #f2f6fc; }
  table.stmt tr.band td { font-weight: 600; color: #1E3C72; background: #eef3fb; }
  table.stmt tr.acct td { color: #444; font-size: 11px; }
  .r { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #999; font-size: 10px; }
  .kpis { margin: 2px 0 12px; }
  .kpi { display: inline-block; margin: 0 8px 4px 0; padding: 2px 8px; background: #eef3fb; border: 1px solid #d6e2f5; border-radius: 4px; }
  .note { margin-bottom: 10px; }
  .note-h { font-weight: 700; color: #1E3C72; margin-bottom: 2px; }
  .policy { color: #444; margin: 2px 0 4px; font-size: 11px; }
  .foot { margin-top: 10px; color: #888; font-size: 10px; text-align: right; }
</style>
</head>
<body>
  <div class="cover">
    <div class="co">${esc(co?.name ?? '—')}</div>
    ${co?.taxId ? `<div class="sub">เลขประจำตัวผู้เสียภาษี / Tax ID: ${esc(co.taxId)}</div>` : ''}
    <div class="fs">งบการเงิน / Financial Statements</div>
    <div class="sub">${periodLine}</div>
    ${reviewStamp()}
  </div>

  <section>
    <h2>งบแสดงฐานะการเงิน / Statement of Financial Position</h2>
    ${stmtTable(pack?.balance_sheet?.rows)}
    ${kpiStrip(pack?.balance_sheet?.kpis)}
  </section>

  <section class="break">
    <h2>งบกำไรขาดทุน / Statement of Profit or Loss</h2>
    ${stmtTable(pack?.profit_and_loss?.rows)}
    ${kpiStrip(pack?.profit_and_loss?.kpis)}
  </section>

  <section class="break">
    <h2>งบแสดงการเปลี่ยนแปลงส่วนของผู้ถือหุ้น / Statement of Changes in Equity</h2>
    ${soceTable()}
  </section>

  ${disaggBlock()}

  ${notesBlock()}

  <div class="foot">${esc(co?.name ?? '')} · ${esc(pack?.ledger ?? 'LEADING')} · หน่วย: บาท / Unit: THB</div>
</body>
</html>`;
  }

  // ── shared layout ───────────────────────────────────────────────────
  private wrap(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Sarabun', sans-serif; color: #1a1a1a; font-size: 12px; margin: 0; padding: 0; }
  .doc { padding: 8px; }
  .brand { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #1E3C72; padding-bottom: 8px; margin-bottom: 12px; }
  .brand .co { font-size: 18px; font-weight: 700; color: #1E3C72; }
  .brand .co small { display: block; font-size: 11px; font-weight: 400; color: #555; }
  .brand .title { font-size: 16px; font-weight: 700; color: #1E3C72; text-align: right; }
  .party { margin-bottom: 10px; }
  .party .head { font-weight: 600; color: #1E3C72; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; }
  table.meta { margin-bottom: 12px; }
  table.meta td { padding: 2px 6px; vertical-align: top; }
  table.meta td.lbl { color: #555; width: 40%; }
  table.grid { margin-bottom: 12px; }
  table.grid th { background: #1E3C72; color: #fff; font-weight: 600; padding: 6px; text-align: left; }
  table.grid td { padding: 5px 6px; border-bottom: 1px solid #e0e0e0; }
  table.grid tr:nth-child(even) td { background: #f7f9fc; }
  .r { text-align: right; }
  .c { text-align: center; }
  table.totals { width: 42%; margin-left: auto; }
  table.totals td { padding: 4px 6px; }
  table.totals td.tlbl { color: #333; }
  table.totals td.tval { text-align: right; font-weight: 600; }
  table.totals tr.grand td { border-top: 2px solid #1E3C72; font-size: 13px; color: #1E3C72; font-weight: 700; }
  .words { margin-top: 10px; font-weight: 600; color: #1E3C72; }
  .footer { margin-top: 28px; display: flex; justify-content: space-between; }
  .sign { width: 40%; text-align: center; border-top: 1px solid #999; padding-top: 4px; color: #555; }
</style>
</head>
<body>
  <div class="doc">
    <div class="brand">
      <div class="co">Invisible Consulting<small>Invisible Enterprise ERP</small></div>
      <div class="title">${esc(title)}</div>
    </div>
    ${body}
    <div class="footer">
      <div class="sign">ผู้รับสินค้า / Received By</div>
      <div class="sign">ผู้มีอำนาจลงนาม / Authorized By</div>
    </div>
  </div>
</body>
</html>`;
  }

  private partyBlock(head: string, party: any): string {
    if (!party) return '';
    const name = esc(party.name ?? party.code ?? '-');
    const addr = esc(party.address ?? '');
    const phone = esc(party.phone ?? '');
    const taxId = esc(party.taxId ?? party.tax_id ?? '');
    return `<div class="party">
      <div class="head">${esc(head)}</div>
      <div>${name}</div>
      ${addr ? `<div>${addr}</div>` : ''}
      ${phone ? `<div>โทร / Tel: ${phone}</div>` : ''}
      ${taxId ? `<div>เลขประจำตัวผู้เสียภาษี / Tax ID: ${taxId}</div>` : ''}
    </div>`;
  }

  private totalsBlock(rows: [string, number][]): string {
    const body = rows
      .map((r, i) => {
        const grand = i === rows.length - 1 && rows.length > 1 ? ' class="grand"' : '';
        return `<tr${grand}><td class="tlbl">${esc(r[0])}</td><td class="tval">${fmtMoney(r[1])} ฿</td></tr>`;
      })
      .join('');
    return `<table class="totals">${body}</table>`;
  }
}

// ── formatting helpers ─────────────────────────────────────────────────
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function fmtMoney(x: number): string {
  return (Math.round(x * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtQty(x: number): string {
  return x.toLocaleString('en-US', { maximumFractionDigits: 3 });
}
// Accounting presentation: negatives in parentheses, zero as a dash.
function fmtAmt(x: number): string {
  const v = Math.round(x * 100) / 100;
  if (v === 0) return '-';
  return v < 0 ? `(${fmtMoney(-v)})` : fmtMoney(v);
}
function fmtDate(ymd: unknown): string {
  const s = String(ymd ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : s;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function bahtWords(amount: number): string {
  try {
    // bahttext exports the function directly (module.exports = bahttext)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('bahttext');
    const fn = typeof mod === 'function' ? mod : mod.bahttext ?? mod.default;
    return fn(amount);
  } catch {
    return `${fmtMoney(amount)} บาทถ้วน`;
  }
}

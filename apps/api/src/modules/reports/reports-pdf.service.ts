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
      <div class="co">Invisible Consulting<small>Oshinei Enterprise ERP</small></div>
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

import { Injectable } from '@nestjs/common';
import { bahtText } from '../../../common/bahttext.util';
import { formatTaxId } from './tax-docs.snapshot';
import { PND_LABELS, WHT_CONDITION_LABELS, incomeType, type PndType } from './wht-rates';
import { PdfRenderer } from '../../pdf/pdf-renderer.service';
import { type A4TemplateConfig, DEFAULT_A4_TEMPLATE, a4LogoHtml, a4HeaderNoteHtml, a4FooterHtml } from '../../../common/a4-template';

// HTML → PDF templates for the three Thai tax documents. Rendering is delegated to the shared PdfRenderer
// (external-service offload or pooled Chromium); if unavailable it returns null → caller sends the HTML.
@Injectable()
export class TaxDocsPdfService {
  constructor(private readonly pdf: PdfRenderer) {}

  renderToPdf(html: string, slip = false): Promise<Buffer | null> {
    return slip
      ? this.pdf.render(html, { width: '80mm', printBackground: true, margin: { top: '4mm', bottom: '4mm', left: '3mm', right: '3mm' } })
      : this.pdf.render(html, { format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  }

  // ── ใบกำกับภาษีเต็มรูป (ม.86/4) — A4 ──
  // `cfg` is the tenant's active, presentation-only no-code template (common/a4-template.ts). It carries an
  // accent colour, an optional logo + header note, custom footer terms/signature captions and an
  // amount-in-words toggle. It is normalized with { fiscal: true } upstream, so the mandatory ม.86/4
  // seller name/address/tax-id lines below are UNCONDITIONAL — a knob can never drop a legally-required field.
  fullTaxInvoiceHtml(inv: any, copy = false, cfg: A4TemplateConfig = DEFAULT_A4_TEMPLATE): string {
    const rows = inv.lines.map((l: any, i: number) => `
      <tr><td class="c">${i + 1}</td><td>${esc(l.description)}</td>
      <td class="r">${l.qty != null ? fmtQty(l.qty) : ''}</td>
      <td class="r">${l.unit_price != null ? fmtMoney(l.unit_price) : ''}</td>
      <td class="r">${fmtMoney(l.amount)}</td></tr>`).join('');
    const b = inv.buyer ?? {};
    return wrapA4(`
      <div class="hdr">
        <div>
          ${a4LogoHtml(cfg, inv.seller.logo_url)}
          <div class="t1">${esc(inv.seller.name)}</div>
          <div>${esc(inv.seller.address)}</div>
          <div>เลขประจำตัวผู้เสียภาษีอากร ${esc(formatTaxId(inv.seller.tax_id))} &nbsp; (${esc(inv.seller.branch_label)})</div>
          ${a4HeaderNoteHtml(cfg)}
        </div>
        <div class="ttl">ใบกำกับภาษี/ใบเสร็จรับเงิน<div class="copy">(${copy ? 'สำเนา' : 'ต้นฉบับ'})</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">ลูกค้า (ผู้ซื้อ)</td><td>${esc(b.name ?? '-')}</td><td class="lbl">เลขที่</td><td>${esc(inv.doc_no)}</td></tr>
        <tr><td class="lbl">ที่อยู่</td><td>${esc(b.address ?? '-')}</td><td class="lbl">วันที่</td><td>${esc(thaiDate(inv.issue_date))}</td></tr>
        <tr><td class="lbl">เลขประจำตัวผู้เสียภาษีผู้ซื้อ</td><td>${esc(b.tax_id ? formatTaxId(b.tax_id) : '-')}</td><td class="lbl">สาขา</td><td>${esc(b.branch_code ? `สาขาที่ ${b.branch_code}` : 'สำนักงานใหญ่')}</td></tr>
      </table>
      <table class="grid">
        <thead><tr><th class="c">ลำดับ</th><th>รายการ</th><th class="r">จำนวน</th><th class="r">ราคา/หน่วย</th><th class="r">จำนวนเงิน</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="totals">
        <tr><td class="tlbl">มูลค่าสินค้า/บริการ</td><td class="tval">${fmtMoney(inv.subtotal)}</td></tr>
        <tr><td class="tlbl">ภาษีมูลค่าเพิ่ม 7%</td><td class="tval">${fmtMoney(inv.vat_amount)}</td></tr>
        <tr class="grand"><td class="tlbl">จำนวนเงินรวมทั้งสิ้น</td><td class="tval">${fmtMoney(inv.grand_total)}</td></tr>
      </table>
      ${cfg.totals.show_amount_in_words ? `<div class="words">( ${esc(bahtText(inv.grand_total))} )</div>` : ''}
      ${a4FooterHtml(cfg, { leftDefault: 'ผู้รับสินค้า / ผู้ซื้อ', rightDefault: 'ผู้รับเงิน / ผู้มีอำนาจลงนาม' })}
    `, 'ใบกำกับภาษีเต็มรูป', { accentColor: cfg.header.accent_color });
  }

  // ── ใบลดหนี้ (ม.86/10) / ใบเพิ่มหนี้ (ม.86/9) — A4 ──
  creditDebitNoteHtml(inv: any): string {
    const isCredit = inv.type === 'credit_note';
    const title = isCredit ? 'ใบลดหนี้' : 'ใบเพิ่มหนี้';
    const section = isCredit ? 'ตามมาตรา 86/10' : 'ตามมาตรา 86/9';
    const rows = inv.lines.map((l: any, i: number) => `
      <tr><td class="c">${i + 1}</td><td>${esc(l.description)}</td>
      <td class="r">${l.qty != null ? fmtQty(l.qty) : ''}</td>
      <td class="r">${l.unit_price != null ? fmtMoney(l.unit_price) : ''}</td>
      <td class="r">${fmtMoney(l.amount)}</td></tr>`).join('');
    const b = inv.buyer ?? {};
    const pending = inv.status === 'PendingApproval';
    return wrapA4(`
      <div class="hdr">
        <div>
          <div class="t1">${esc(inv.seller.name)}</div>
          <div>${esc(inv.seller.address)}</div>
          <div>เลขประจำตัวผู้เสียภาษีอากร ${esc(formatTaxId(inv.seller.tax_id))} &nbsp; (${esc(inv.seller.branch_label)})</div>
        </div>
        <div class="ttl">${title}<div class="copy">${section}${pending ? ' · (รออนุมัติ)' : ''}</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">ลูกค้า (ผู้ซื้อ)</td><td>${esc(b.name ?? '-')}</td><td class="lbl">เลขที่</td><td>${esc(inv.doc_no)}</td></tr>
        <tr><td class="lbl">ที่อยู่</td><td>${esc(b.address ?? '-')}</td><td class="lbl">วันที่</td><td>${esc(thaiDate(inv.issue_date))}</td></tr>
        <tr><td class="lbl">เลขประจำตัวผู้เสียภาษีผู้ซื้อ</td><td>${esc(b.tax_id ? formatTaxId(b.tax_id) : '-')}</td><td class="lbl">อ้างอิงใบกำกับภาษีเดิม</td><td>${esc(inv.original_doc_no ?? '-')}</td></tr>
        <tr><td class="lbl">เหตุผล</td><td colspan="3">${esc(inv.reason ?? '-')}</td></tr>
      </table>
      <table class="grid">
        <thead><tr><th class="c">ลำดับ</th><th>รายการที่${isCredit ? 'ลด' : 'เพิ่ม'}</th><th class="r">จำนวน</th><th class="r">ราคา/หน่วย</th><th class="r">${isCredit ? 'มูลค่าที่ลด' : 'มูลค่าที่เพิ่ม'}</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="totals">
        <tr><td class="tlbl">${isCredit ? 'ผลต่างมูลค่าสินค้า/บริการ' : 'มูลค่าที่เพิ่ม'}</td><td class="tval">${fmtMoney(inv.subtotal)}</td></tr>
        <tr><td class="tlbl">ภาษีมูลค่าเพิ่ม 7%</td><td class="tval">${fmtMoney(inv.vat_amount)}</td></tr>
        <tr class="grand"><td class="tlbl">${isCredit ? 'จำนวนเงินที่ลดทั้งสิ้น' : 'จำนวนเงินที่เพิ่มทั้งสิ้น'}</td><td class="tval">${fmtMoney(inv.grand_total)}</td></tr>
      </table>
      <div class="words">( ${esc(bahtText(inv.grand_total))} )</div>
      <div class="foot"><div class="sign">ผู้รับเอกสาร / ผู้ซื้อ</div><div class="sign">ผู้มีอำนาจลงนาม</div></div>
    `, title);
  }

  // ── ใบกำกับภาษีอย่างย่อ (ม.86/6) — 80mm thermal slip ──
  abbreviatedTaxInvoiceHtml(inv: any): string {
    const rows = inv.lines.map((l: any) => `
      <tr><td>${esc(l.description)}</td><td class="r">${l.qty != null ? fmtQty(l.qty) : ''}</td><td class="r">${fmtMoney(l.amount)}</td></tr>`).join('');
    return `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"/>
      <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet"/>
      <style>
        *{box-sizing:border-box} body{font-family:'Sarabun',sans-serif;font-size:11px;margin:0;padding:0;width:74mm}
        .ct{text-align:center} .b{font-weight:700} hr{border:0;border-top:1px dashed #555;margin:4px 0}
        table{width:100%;border-collapse:collapse} td{padding:1px 0;vertical-align:top} .r{text-align:right}
        .ttl{font-size:13px;font-weight:700;margin:2px 0}
      </style></head><body>
      <div class="ct b">${esc(inv.seller.name)}</div>
      <div class="ct">เลขผู้เสียภาษี ${esc(formatTaxId(inv.seller.tax_id))}</div>
      <div class="ct">(${esc(inv.seller.branch_label)})</div>
      <hr/>
      <div class="ct ttl">ใบกำกับภาษีอย่างย่อ</div>
      <div>เลขที่: ${esc(inv.doc_no)}</div>
      <div>วันที่: ${esc(thaiDate(inv.issue_date))}</div>
      <hr/>
      <table>${rows}</table>
      <hr/>
      <table>
        <tr><td class="b">รวมเงิน (รวม VAT)</td><td class="r b">${fmtMoney(inv.grand_total)}</td></tr>
        <tr><td>VAT 7% ที่รวมอยู่</td><td class="r">${fmtMoney(inv.vat_amount)}</td></tr>
      </table>
      <div class="ct b">** ราคารวมภาษีมูลค่าเพิ่มแล้ว **</div>
      <hr/>
      <div class="ct">ขอบคุณที่ใช้บริการ</div>
      <div class="ct">* ต้องการใบกำกับภาษีเต็มรูป โปรดแจ้งพนักงาน *</div>
      </body></html>`;
  }

  // ── หนังสือรับรองการหักภาษี ณ ที่จ่าย 50 ทวิ (ม.50 ทวิ) — A4 form ──
  whtCertificateHtml(cert: any, copy: 'copy1' | 'copy2' | 'copy3' = 'copy1'): string {
    const copyLabel = copy === 'copy1' ? 'ฉบับที่ 1 (สำหรับผู้ถูกหักภาษี ณ ที่จ่าย ใช้แนบพร้อมกับแบบแสดงรายการ)'
      : copy === 'copy2' ? 'ฉบับที่ 2 (สำหรับผู้ถูกหักภาษี ณ ที่จ่ายเก็บไว้เป็นหลักฐาน)'
      : 'ฉบับที่ 3 (สำหรับผู้มีหน้าที่หักภาษี ณ ที่จ่าย)';
    // fixed 6-row income table; place each cert line into its row group
    const rowFor = (codes: string[]) => cert.lines.filter((l: any) => codes.includes(l.income_type));
    const sumRow = (codes: string[]) => {
      const ls = rowFor(codes);
      if (!ls.length) return { paid: '', tax: '', date: '' };
      return { paid: fmtMoney(ls.reduce((a: number, l: any) => a + l.amount_paid, 0)), tax: fmtMoney(ls.reduce((a: number, l: any) => a + l.tax_withheld, 0)), date: thaiDate(ls[0].date_paid ?? cert.date_paid) };
    };
    const r1 = sumRow(['40(1)']); const r2 = sumRow(['40(2)']); const r3 = sumRow(['40(3)']);
    const r4 = sumRow(['40(4a)', '40(4b)']);
    const r5 = sumRow(['40(5)', '40(6)', '40(7-8)', '3tre-service', '3tre-ad', '3tre-transport', '3tre-prize']);
    const r6 = sumRow(['other']);
    const r5desc = rowFor(['40(5)', '40(6)', '40(7-8)', '3tre-service', '3tre-ad', '3tre-transport', '3tre-prize']).map((l: any) => incomeType(l.income_type)?.labelTh ?? l.income_type).join(', ');
    const pndBox = (p: PndType) => `<span class="bx">${cert.pnd_type === p ? '☑' : '☐'}</span> ${PND_LABELS[p]}`;
    const condBox = (c: string) => `<span class="bx">${cert.wht_condition === c ? '☑' : '☐'}</span> ${WHT_CONDITION_LABELS[c]}`;
    const taxRow = (label: string, s: any) => `<tr><td>${label}</td><td class="c">${s.date}</td><td class="r">${s.paid}</td><td class="r">${s.tax}</td></tr>`;
    return wrapA4(`
      ${cert.is_replacement ? '<div class="ct b" style="color:#b00">** ใบแทน **</div>' : ''}
      <div class="ct copylbl">${esc(copyLabel)}</div>
      <div class="ct ttl50">หนังสือรับรองการหักภาษี ณ ที่จ่าย<br/>ตามมาตรา 50 ทวิ แห่งประมวลรัษฎากร</div>
      <table class="meta"><tr><td class="r">เล่มที่ ${esc(cert.book_no ?? '____')} &nbsp;&nbsp; ลำดับที่ ${esc(cert.run_no ?? cert.doc_no)}</td></tr></table>
      <div class="party"><span class="b">ผู้มีหน้าที่หักภาษี ณ ที่จ่าย (ผู้จ่ายเงิน):</span></div>
      <div>เลขประจำตัวผู้เสียภาษีอากร ${esc(formatTaxId(cert.payer.tax_id))}</div>
      <div>ชื่อ ${esc(cert.payer.name)}</div>
      <div>ที่อยู่ ${esc(cert.payer.address)}</div>
      <div class="party" style="margin-top:6px"><span class="b">ผู้ถูกหักภาษี ณ ที่จ่าย (ผู้รับเงิน):</span></div>
      <div>เลขประจำตัวผู้เสียภาษีอากร ${esc(formatTaxId(cert.payee.tax_id))}</div>
      <div>ชื่อ ${esc(cert.payee.name)}</div>
      <div>ที่อยู่ ${esc(cert.payee.address ?? '-')}</div>
      <div class="pnd">${pndBox('PND1K')} &nbsp; ${pndBox('PND2')} &nbsp; ${pndBox('PND3')} &nbsp; ${pndBox('PND53')}</div>
      <table class="grid wht">
        <thead><tr><th>ประเภทเงินได้พึงประเมินที่จ่าย</th><th class="c">วันเดือนปีที่จ่าย</th><th class="r">จำนวนเงินที่จ่าย</th><th class="r">ภาษีที่หักนำส่ง</th></tr></thead>
        <tbody>
          ${taxRow('1. เงินเดือน ค่าจ้าง ฯลฯ ม.40(1)', r1)}
          ${taxRow('2. ค่าธรรมเนียม ค่านายหน้า ฯลฯ ม.40(2)', r2)}
          ${taxRow('3. ค่าแห่งลิขสิทธิ์ ฯลฯ ม.40(3)', r3)}
          ${taxRow('4. ดอกเบี้ย/เงินปันผล ฯลฯ ม.40(4)', r4)}
          ${taxRow(`5. ตามคำสั่งฯ ม.3 เตรส ${r5desc ? `(${esc(r5desc)})` : '(ค่าจ้างทำของ/บริการ/โฆษณา/เช่า ฯลฯ)'}`, r5)}
          ${taxRow('6. เงินได้นอกจาก 1.–5.', r6)}
          <tr class="grand"><td class="r">รวมเงินที่จ่ายและภาษีที่หักนำส่ง</td><td></td><td class="r">${fmtMoney(cert.total_paid)}</td><td class="r">${fmtMoney(cert.total_wht)}</td></tr>
        </tbody>
      </table>
      <div class="words">รวมเงินภาษีที่หักนำส่ง (ตัวอักษร) ( ${esc(bahtText(cert.total_wht))} )</div>
      <div class="cond">ผู้จ่ายเงิน &nbsp; ${condBox('withhold')} &nbsp; ${condBox('absorb_always')} &nbsp; ${condBox('absorb_once')} &nbsp; <span class="bx">${cert.wht_condition === 'other' ? '☑' : '☐'}</span> อื่นๆ ${esc(cert.wht_condition_other ?? '')}</div>
      <div class="certify">ขอรับรองว่าข้อความและตัวเลขดังกล่าวข้างต้นถูกต้องตรงกับความจริงทุกประการ</div>
      <div class="foot"><div class="sign">ลงชื่อ ${esc(cert.signer_name ?? '')} ผู้จ่ายเงิน<br/>ยื่นวันที่ ${esc(thaiDate(cert.date_paid))}</div></div>
    `, 'หนังสือรับรองหักภาษี ณ ที่จ่าย 50 ทวิ');
  }
}

// ── A4 shell ──
// `opts.accentColor` overrides the brand accent (#1E3C72) for the header rules/headings + grid, driven by a
// tenant's no-code document template (presentation only; see common/a4-template.ts). A non-#RRGGBB value
// falls back to the brand default so a bad config can never break the shell. The `.brandlogo`/`.hnote` +
// `.terms`/`.fline`/`.sign .who` classes back the shared a4LogoHtml/a4HeaderNoteHtml/a4FooterHtml helpers.
const TAX_A4_BRAND = '#1E3C72';
const TAX_A4_HEX = /^#[0-9a-fA-F]{6}$/;
function wrapA4(body: string, title: string, opts: { accentColor?: string } = {}): string {
  const A = opts.accentColor && TAX_A4_HEX.test(opts.accentColor) ? opts.accentColor : TAX_A4_BRAND;
  return `<!DOCTYPE html><html lang="th"><head><meta charset="utf-8"/><title>${esc(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box} body{font-family:'Sarabun',sans-serif;color:#1a1a1a;font-size:12px;margin:0}
    .hdr{display:flex;justify-content:space-between;border-bottom:2px solid ${A};padding-bottom:6px;margin-bottom:8px}
    .brandlogo{max-height:46px;max-width:180px;margin-bottom:4px;display:block} .hnote{font-size:11px;color:#555}
    .t1{font-size:16px;font-weight:700;color:${A}} .ttl{font-size:15px;font-weight:700;color:${A};text-align:right}
    .copy{font-size:11px;font-weight:400;color:#b00} .copylbl{font-size:11px;color:#b00}
    .ttl50{font-size:15px;font-weight:700;color:${A};text-align:center;margin:4px 0 8px}
    .ct{text-align:center} .b{font-weight:700} .r{text-align:right} .c{text-align:center}
    table{width:100%;border-collapse:collapse} table.meta td{padding:2px 6px} td.lbl{color:#555;width:18%}
    table.grid{margin:8px 0} table.grid th{background:${A};color:#fff;padding:5px;text-align:left;font-size:11px}
    table.grid td{padding:4px 6px;border-bottom:1px solid #e0e0e0} table.grid tr.grand td{border-top:2px solid ${A};font-weight:700}
    table.wht td{border:1px solid #999;font-size:11px;height:18px}
    table.totals{width:45%;margin-left:auto;margin-top:6px} table.totals td{padding:3px 6px} td.tval{text-align:right;font-weight:600}
    table.totals tr.grand td{border-top:2px solid ${A};color:${A};font-size:13px}
    .words{margin-top:8px;font-weight:600;color:${A}} .pnd{margin:8px 0} .bx{font-size:14px}
    .terms{margin-top:10px;font-size:11px;color:#333;white-space:pre-wrap} .fline{margin-top:2px;font-size:11px;color:#555}
    .cond{margin:8px 0} .certify{margin-top:10px;font-size:11px} .foot{margin-top:24px;display:flex;justify-content:space-between}
    .sign{width:45%;text-align:center;border-top:1px solid #999;padding-top:4px;color:#555}
    .sign .who{margin-top:18px;color:#1a1a1a;font-weight:600}
    .party{color:${A}}
  </style></head><body>${body}</body></html>`;
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

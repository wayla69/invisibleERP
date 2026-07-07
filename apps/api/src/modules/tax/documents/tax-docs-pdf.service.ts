import { Injectable } from '@nestjs/common';
import { bahtText } from '../../../common/bahttext.util';
import { formatTaxId } from './tax-docs.snapshot';
import { PND_LABELS, WHT_CONDITION_LABELS, incomeType, type PndType } from './wht-rates';
import { PdfRenderer } from '../../pdf/pdf-renderer.service';
import { type A4TemplateConfig, DEFAULT_A4_TEMPLATE, a4LogoHtml, a4HeaderNoteHtml, a4FooterHtml, renderAbbreviatedTaxSlip } from '../../../common/a4-template';

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
    const s = inv.seller ?? {};
    const telFax = [s.phone ? `Tel ${s.phone}` : '', s.fax ? `Fax ${s.fax}` : ''].filter(Boolean).join(' ');
    return wrapA4(`
      <div class="hdr">
        <div>
          ${a4LogoHtml(cfg, inv.seller.logo_url)}
          <div class="t1">${esc(inv.seller.name)}</div>
          <div>${esc(inv.seller.address)}</div>
          ${telFax ? `<div>${esc(telFax)}</div>` : ''}
          <div>เลขประจำตัวผู้เสียภาษีอากร ${esc(formatTaxId(inv.seller.tax_id))} &nbsp; (${esc(inv.seller.branch_label)})</div>
          ${a4HeaderNoteHtml(cfg)}
        </div>
        <div class="ttl">ใบเสร็จรับเงิน/ใบกำกับภาษี<div class="copy">(${copy ? 'สำเนา' : 'ต้นฉบับ'})</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">ลูกค้า (ผู้ซื้อ)</td><td>${esc(b.name ?? '-')}</td><td class="lbl">เลขที่</td><td>${esc(inv.doc_no)}</td></tr>
        <tr><td class="lbl">ที่อยู่</td><td>${esc(b.address ?? '-')}</td><td class="lbl">วันที่</td><td>${esc(thaiDate(inv.issue_date))}</td></tr>
        <tr><td class="lbl">เลขประจำตัวผู้เสียภาษีผู้ซื้อ</td><td>${esc(b.tax_id ? formatTaxId(b.tax_id) : '-')}</td><td class="lbl">สาขา</td><td>${esc(b.branch_code ? `สาขาที่ ${b.branch_code}` : 'สำนักงานใหญ่')}</td></tr>
        ${inv.due_date ? `<tr><td></td><td></td><td class="lbl">วันครบกำหนดชำระเงิน</td><td>${esc(thaiDate(inv.due_date))}</td></tr>` : ''}
      </table>
      <table class="grid">
        <thead><tr><th class="c">ลำดับ</th><th>รายการ</th><th class="r">จำนวน</th><th class="r">ราคา/หน่วย</th><th class="r">จำนวนเงิน (ไม่รวมภาษี)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="totals">
        <tr><td class="tlbl">มูลค่าสินค้า/บริการ (Sub Total)</td><td class="tval">${fmtMoney(inv.subtotal)}</td></tr>
        <tr><td class="tlbl">ภาษีมูลค่าเพิ่ม 7% (VAT)</td><td class="tval">${fmtMoney(inv.vat_amount)}</td></tr>
        <tr class="grand"><td class="tlbl">จำนวนเงินรวมทั้งสิ้น (Grand Total)</td><td class="tval">${fmtMoney(inv.grand_total)}</td></tr>
      </table>
      ${cfg.totals.show_amount_in_words ? `<div class="words">( ${esc(bahtText(inv.grand_total))} )</div>` : ''}
      ${paidByHtml(inv.payment)}
      ${a4FooterHtml(cfg, { leftDefault: 'ผู้รับเงิน (Collector)', rightDefault: 'ผู้อนุมัติจ่ายเงิน (Authorized By)' })}
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
  // Presentation-only: the tenant's active template can add a header note (slogan/branch) + footer notes; the
  // mandatory ม.86/6 elements (seller name/tax-id, title, VAT-inclusive total) are structural. The slip layout
  // is shared with the template designer's preview (common/a4-template.ts) so both paths always agree.
  abbreviatedTaxInvoiceHtml(inv: any, cfg: A4TemplateConfig = DEFAULT_A4_TEMPLATE): string {
    return renderAbbreviatedTaxSlip(cfg, {
      seller: inv.seller, doc_no: inv.doc_no, issue_date: inv.issue_date,
      lines: inv.lines, grand_total: inv.grand_total, vat_amount: inv.vat_amount,
    });
  }

  // ── หนังสือรับรองการหักภาษี ณ ที่จ่าย 50 ทวิ (ม.50 ทวิ) — A4 form ──
  // Verbatim layout of the RD's official form (approve_wh3_081156.pdf): payer then payee stacked
  // full-width (each with a 13-cell Tax-ID grid), the ลำดับที่/ในแบบ line + 7-way ภ.ง.ด. checkboxes,
  // the 6-row income table (40(4) split into (ก) ดอกเบี้ย / (ข) เงินปันผล with the full credit/no-credit
  // sub-list), the กบข./ประกันสังคม/สำรองเลี้ยงชีพ line, the คำเตือน + signature/stamp footer, and the
  // exact 3-item หมายเหตุ on the 13-digit Tax ID.
  whtCertificateHtml(cert: any, copy: 'copy1' | 'copy2' | 'copy3' = 'copy1'): string {
    const copyLabel = copy === 'copy1' ? 'ฉบับที่ 1 (สำหรับผู้ถูกหักภาษี ณ ที่จ่าย ใช้แนบพร้อมกับแบบแสดงรายการภาษี)'
      : copy === 'copy2' ? 'ฉบับที่ 2 (สำหรับผู้ถูกหักภาษี ณ ที่จ่าย เก็บไว้เป็นหลักฐาน)'
      : 'ฉบับที่ 3 (สำหรับผู้มีหน้าที่หักภาษี ณ ที่จ่าย)';
    // fixed 6-row income table (40(4) split into (ก)/(ข)); place each cert line into its row group
    const rowFor = (codes: string[]) => cert.lines.filter((l: any) => codes.includes(l.income_type));
    const sumRow = (codes: string[]) => {
      const ls = rowFor(codes);
      if (!ls.length) return { paid: '', tax: '', date: '' };
      return { paid: fmtMoney(ls.reduce((a: number, l: any) => a + l.amount_paid, 0)), tax: fmtMoney(ls.reduce((a: number, l: any) => a + l.tax_withheld, 0)), date: thaiDate(ls[0].date_paid ?? cert.date_paid) };
    };
    const r1 = sumRow(['40(1)']); const r2 = sumRow(['40(2)']); const r3 = sumRow(['40(3)']);
    const r4a = sumRow(['40(4a)']); const r4b = sumRow(['40(4b)']);
    const r5 = sumRow(['40(5)', '40(6)', '40(7-8)', '3tre-service', '3tre-ad', '3tre-transport', '3tre-prize']);
    const r6 = sumRow(['other']);
    const r5desc = rowFor(['40(5)', '40(6)', '40(7-8)', '3tre-service', '3tre-ad', '3tre-transport', '3tre-prize']).map((l: any) => incomeType(l.income_type)?.labelTh ?? l.income_type).join(', ');
    // official numbering: (1) 1ก (2) 1ก พิเศษ (3) 2 (4) 3 (5) 2ก (6) 3ก (7) 53
    const pndBox = (p: PndType, n: number) => `<span class="bx">${cert.pnd_type === p ? '☑' : '☐'}</span> (${n}) ${PND_LABELS[p]}`;
    const condBox = (n: number, c: string) => `<span class="bx">${cert.wht_condition === c ? '☑' : '☐'}</span> (${n}) ${WHT_CONDITION_LABELS[c]}`;
    const taxRow = (label: string, s: any) => `<tr><td>${label}</td><td class="c">${s.date}</td><td class="r">${s.paid}</td><td class="r">${s.tax}</td></tr>`;
    const partyBlock = (title: string, p: any) => `
      <div class="wht50box">
        <div class="row1"><span class="b">${title}</span> <span>เลขประจำตัวผู้เสียภาษีอากร (13 หลัก)* ${taxIdBoxes(p.tax_id)}</span></div>
        <div>ชื่อ ${esc(p.name)} <span class="hint">(ให้ระบุว่าเป็น บุคคล นิติบุคคล บริษัท สมาคม หรือคณะบุคคล)</span></div>
        <div>ที่อยู่ ${esc(p.address ?? '-')} <span class="hint">(ให้ระบุชื่ออาคาร/หมู่บ้าน ห้องเลขที่ ชั้นที่ เลขที่ ตรอก/ซอย หมู่ที่ ถนน ตำบล/แขวง อำเภอ/เขต จังหวัด)</span></div>
      </div>`;
    return wrapA4(`
      ${cert.is_replacement ? '<div class="ct b" style="color:#b00">** ใบแทน **</div>' : ''}
      <div class="ct copylbl">${esc(copyLabel)}</div>
      <div class="ct ttl50">หนังสือรับรองการหักภาษี ณ ที่จ่าย<br/>ตามมาตรา 50 ทวิ แห่งประมวลรัษฎากร</div>
      <div class="r" style="font-size:11px;margin-bottom:6px">เล่มที่ ${esc(cert.book_no ?? '-')} &nbsp;&nbsp; เลขที่ ${esc(cert.run_no ?? cert.doc_no)}</div>
      ${partyBlock('ผู้มีหน้าที่หักภาษี ณ ที่จ่าย : -', cert.payer)}
      ${partyBlock('ผู้ถูกหักภาษี ณ ที่จ่าย : -', cert.payee)}
      <div class="pnd"><span class="b">ลำดับที่</span> ${esc(cert.run_no ?? '-')} <span class="b">ในแบบ</span></div>
      <div class="pnd">${pndBox('PND1K', 1)} &nbsp; ${pndBox('PND1KS', 2)} &nbsp; ${pndBox('PND2', 3)} &nbsp; ${pndBox('PND3', 4)}</div>
      <div class="pnd">${pndBox('PND2K', 5)} &nbsp; ${pndBox('PND3K', 6)} &nbsp; ${pndBox('PND53', 7)}</div>
      <div class="hint">(ให้สามารถอ้างอิงหรือสอบยันกันได้ระหว่างลำดับที่ตามหนังสือรับรองฯ กับแบบยื่นรายการภาษีหักที่จ่าย)</div>
      <table class="grid wht">
        <thead><tr><th>ประเภทเงินได้พึงประเมินที่จ่าย</th><th class="c">วัน เดือน หรือปีภาษี<br/>ที่จ่าย</th><th class="r">จำนวนเงินที่จ่าย</th><th class="r">ภาษีที่หัก<br/>และนำส่งไว้</th></tr></thead>
        <tbody>
          ${taxRow('1. เงินเดือน ค่าจ้าง เบี้ยเลี้ยง โบนัส ฯลฯ ตามมาตรา 40(1)', r1)}
          ${taxRow('2. ค่าธรรมเนียม ค่านายหน้า ฯลฯ ตามมาตรา 40(2)', r2)}
          ${taxRow('3. ค่าแห่งลิขสิทธิ์ ฯลฯ ตามมาตรา 40(3)', r3)}
          ${taxRow('4. (ก) ดอกเบี้ย ฯลฯ ตามมาตรา 40(4)(ก)', r4a)}
          ${taxRow('&nbsp;&nbsp;&nbsp;(ข) เงินปันผล เงินส่วนแบ่งกำไร ฯลฯ ตามมาตรา 40(4)(ข)', r4b)}
          <tr><td colspan="4" class="subnote">
            (1) กรณีผู้ได้รับเงินปันผลได้รับเครดิตภาษี โดยจ่ายจากกำไรสุทธิของกิจการที่ต้องเสียภาษีเงินได้นิติบุคคลในอัตราดังนี้<br/>
            &emsp;<span class="bx">☐</span> (1.1) อัตราร้อยละ 30 ของกำไรสุทธิ &nbsp; <span class="bx">☐</span> (1.2) อัตราร้อยละ 25 ของกำไรสุทธิ<br/>
            &emsp;<span class="bx">☐</span> (1.3) อัตราร้อยละ 20 ของกำไรสุทธิ &nbsp; <span class="bx">☐</span> (1.4) อัตราอื่น ๆ (ระบุ)______ ของกำไรสุทธิ<br/>
            (2) กรณีผู้ได้รับเงินปันผลไม่ได้รับเครดิตภาษี เนื่องจากจ่ายจาก<br/>
            &emsp;<span class="bx">☐</span> (2.1) กำไรสุทธิของกิจการที่ได้รับยกเว้นภาษีเงินได้นิติบุคคล<br/>
            &emsp;<span class="bx">☐</span> (2.2) เงินปันผลหรือเงินส่วนแบ่งของกำไรที่ได้รับยกเว้นไม่ต้องนำมารวมคำนวณเป็นรายได้เพื่อเสียภาษีเงินได้นิติบุคคล<br/>
            &emsp;<span class="bx">☐</span> (2.3) กำไรสุทธิส่วนที่ได้หักผลขาดทุนสุทธิยกมาไม่เกิน 5 ปีก่อนรอบระยะเวลาบัญชีปีปัจจุบัน<br/>
            &emsp;<span class="bx">☐</span> (2.4) กำไรที่รับรู้ทางบัญชีโดยวิธีส่วนได้เสีย (equity method)<br/>
            &emsp;<span class="bx">☐</span> (2.5) อื่น ๆ (ระบุ)______________________________</td></tr>
          ${taxRow(`5. การจ่ายเงินได้ที่ต้องหักภาษี ณ ที่จ่าย ตามคำสั่งกรมสรรพากรที่ออกตามมาตรา 3 เตรส เช่น รางวัล ส่วนลดหรือประโยชน์ใด ๆ เนื่องจากการส่งเสริมการขาย รางวัลในการประกวด การแข่งขัน การชิงโชค ค่าแสดงของนักแสดงสาธารณะ ค่าจ้างทำของ ค่าโฆษณา ค่าเช่า ค่าขนส่ง ค่าบริการ ค่าเบี้ยประกันวินาศภัย ฯลฯ${r5desc ? ` (${esc(r5desc)})` : ''}`, r5)}
          ${taxRow('6. อื่น ๆ (ระบุ)', r6)}
          <tr class="grand"><td class="r">รวมเงินที่จ่ายและภาษีที่หักนำส่ง</td><td></td><td class="r">${fmtMoney(cert.total_paid)}</td><td class="r">${fmtMoney(cert.total_wht)}</td></tr>
        </tbody>
      </table>
      <div class="words">รวมเงินภาษีที่หักนำส่ง (ตัวอักษร) ( ${esc(bahtText(cert.total_wht))} )</div>
      <div class="pnd" style="font-size:10px">เงินที่จ่ายเข้า กบข./กสจ./กองทุนสงเคราะห์ครูโรงเรียนเอกชน.....................บาท กองทุนประกันสังคม.....................บาท กองทุนสำรองเลี้ยงชีพ.....................บาท</div>
      <div class="cond">ผู้จ่ายเงิน &nbsp; ${condBox(1, 'withhold')} &nbsp; ${condBox(2, 'absorb_always')} &nbsp; ${condBox(3, 'absorb_once')} &nbsp; <span class="bx">${cert.wht_condition === 'other' ? '☑' : '☐'}</span> (4) อื่น ๆ (ระบุ) ${esc(cert.wht_condition_other ?? '')}</div>
      <div class="foot50">
        <div class="warnbox"><span class="b">คำเตือน</span> ผู้มีหน้าที่ออกหนังสือรับรองการหักภาษี ณ ที่จ่าย ฝ่าฝืนไม่ปฏิบัติตามมาตรา 50 ทวิ แห่งประมวลรัษฎากร ต้องรับโทษทางอาญาตามมาตรา 35 แห่งประมวลรัษฎากร</div>
        <div class="certbox">
          <div class="certify">ขอรับรองว่าข้อความและตัวเลขดังกล่าวข้างต้นถูกต้องตรงกับความจริงทุกประการ</div>
          <div class="sign">ลงชื่อ ${esc(cert.signer_name ?? '')} ผู้จ่ายเงิน<br/>${esc(thaiDate(cert.date_paid))} (วัน เดือน ปี ที่ออกหนังสือรับรองฯ)</div>
          <div class="stamp">ประทับตรา<br/>นิติบุคคล<br/>(ถ้ามี)</div>
        </div>
      </div>
      <div class="note50"><span class="b">หมายเหตุ</span> เลขประจำตัวผู้เสียภาษีอากร (13 หลัก)* หมายถึง<br/>
        1. กรณีบุคคลธรรมดาไทย ให้ใช้เลขประจำตัวประชาชนของกรมการปกครอง<br/>
        2. กรณีนิติบุคคล ให้ใช้เลขทะเบียนนิติบุคคลของกรมพัฒนาธุรกิจการค้า<br/>
        3. กรณีอื่น ๆ นอกเหนือจาก 1. และ 2. ให้ใช้เลขประจำตัวผู้เสียภาษีอากร (13 หลัก) ของกรมสรรพากร</div>
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
    .wht50box{border:1px solid #999;padding:5px 8px;margin:4px 0;font-size:11px}
    .row1{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:2px}
    .hint{font-size:9px;color:#777}
    .txboxes{display:inline-flex;margin-left:4px}
    .txcell{display:inline-block;width:13px;height:15px;border:1px solid #999;text-align:center;font-size:10px;line-height:15px;margin-right:1px}
    table.wht td.subnote{border:1px solid #999;font-size:9px;color:#333;padding:4px 6px;height:auto;line-height:1.5}
    .note50{margin-top:10px;font-size:10px;color:#555;line-height:1.6}
    .foot50{display:flex;justify-content:space-between;gap:12px;margin-top:14px}
    .warnbox{width:46%;font-size:10px;border:1px solid #999;padding:6px;color:#333}
    .certbox{width:50%;text-align:center}
    .stamp{border:1px dashed #999;width:80px;height:50px;margin:6px auto 0;font-size:9px;color:#999;display:flex;align-items:center;justify-content:center;text-align:center}
    .paidby{border:1px solid #999;padding:6px 8px;margin-top:10px;font-size:11px}
    .paidby .row{margin-top:3px}
  </style></head><body>${body}</body></html>`;
}

// 13 individual boxed digit cells for a Tax ID, matching the printed ล.ย.02/50-ทวิ form layout
function taxIdBoxes(id: unknown): string {
  const d = String(id ?? '').replace(/\D/g, '').padEnd(13, ' ').slice(0, 13);
  return `<span class="txboxes">${[...d].map((ch) => `<span class="txcell">${ch.trim() ? esc(ch) : ''}</span>`).join('')}</span>`;
}

// "ชำระเงินโดย" (Paid By) block for the combined ใบเสร็จรับเงิน/ใบกำกับภาษี — a receipt-style payment
// record, not a ม.86/4-mandatory particular. Always prints the section (boxes unchecked, fields blank when
// no payment was recorded) so the layout is stable whether or not the invoice carries payment data.
function paidByHtml(payment: { paid_by?: string; paid_by_other?: string | null; bank?: string | null; cheque_no?: string | null; branch?: string | null } | null | undefined): string {
  const p = payment ?? {};
  const box = (k: string) => (p.paid_by === k ? '☑' : '☐');
  return `
    <div class="paidby">
      <div class="b">ชำระเงินโดย (Paid By)</div>
      <div class="row">
        <span class="bx">${box('transfer')}</span> โอนเงิน (Transfer) &nbsp;&nbsp;
        <span class="bx">${box('cash')}</span> เงินสด (Cash) &nbsp;&nbsp;
        <span class="bx">${box('cheque')}</span> เช็คธนาคาร (Cheque Bank) &nbsp;&nbsp;
        <span class="bx">${box('other')}</span> อื่นๆ (ระบุ) ${esc(p.paid_by === 'other' ? (p.paid_by_other ?? '') : '')}
      </div>
      <div class="row">ธนาคาร (Bank) ${esc(p.bank ?? '')} &nbsp;&nbsp;&nbsp; เลขที่เช็ค (Cheque No.) ${esc(p.cheque_no ?? '')} &nbsp;&nbsp;&nbsp; สาขา (Branch) ${esc(p.branch ?? '')}</div>
    </div>`;
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

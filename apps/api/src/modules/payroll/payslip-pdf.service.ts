import { Injectable } from '@nestjs/common';
import { bahtText } from '../../common/bahttext.util';
import { wrapA4, sellerHeaderHtml, esc, fmtMoney, thaiDate, type DocParty } from '../../common/doc-html';
import { type A4TemplateConfig, DEFAULT_A4_TEMPLATE, a4LogoHtml, a4HeaderNoteHtml, a4FooterHtml } from '../../common/a4-template';
import { PdfRenderer } from '../pdf/pdf-renderer.service';

export interface PayslipPrintData {
  slip_id: number;
  period: string;            // 'YYYY-MM'
  pay_date: string | null;
  entry_no: string | null;
  emp_code: string | null;
  emp_name: string | null;
  position: string | null;
  department: string | null;
  national_id: string | null; // masked for print (PDPA) — last 4 digits only
  currency: string;
  seller: DocParty;
  // Earnings
  base: number;              // เงินเดือนพื้นฐาน (derived: gross − ot + unpaid)
  ot_pay: number;            // ค่าล่วงเวลา
  gross: number;             // รายได้รวม (base + ot − unpaid)
  // Deductions
  unpaid: number;            // หักลาไม่รับค่าจ้าง
  sso_employee: number;      // ประกันสังคม (ลูกจ้าง)
  pf_employee: number;       // กองทุนสำรองเลี้ยงชีพ (ลูกจ้าง)
  wht: number;               // ภาษีหัก ณ ที่จ่าย (ภ.ง.ด.1)
  net: number;               // เงินได้สุทธิ
  // Employer contributions (informational — not deducted from the employee)
  sso_employer: number;
  pf_employer: number;
  template?: A4TemplateConfig; // resolved active no-code template (presentation only); default when absent
}

// เดือน (Thai month names) for the period header.
const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
function periodTh(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period ?? '');
  if (!m) return esc(period ?? '-');
  const month = TH_MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${month} ${Number(m[1]) + 543}`;
}

// HTML → PDF template for the สลิปเงินเดือน (Payslip) — the internal, employee-facing earnings statement.
// Unlike the external documents this carries PII, so access is PDPA-scoped at the endpoint (an employee sees
// only their own; HR/payroll sees any) and the citizen-ID is masked on the face of the slip. Same shared A4
// shell + PdfRenderer (HTML fallback when Chromium absent) as every other printed document.
@Injectable()
export class PayslipPdfService {
  constructor(private readonly pdf: PdfRenderer) {}

  renderToPdf(html: string): Promise<Buffer | null> {
    return this.pdf.render(html, { format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  }

  payslipHtml(p: PayslipPrintData, cfg: A4TemplateConfig = DEFAULT_A4_TEMPLATE): string {
    const ccy = esc(p.currency || 'THB');
    const earnings = p.base + p.ot_pay;
    const deductions = p.unpaid + p.sso_employee + p.pf_employee + p.wht;
    return wrapA4(`
      <div class="hdr">
        ${sellerHeaderHtml(p.seller, { showAddress: cfg.body.show_seller_address, showTaxId: cfg.body.show_seller_tax_id, logoHtml: a4LogoHtml(cfg, p.seller.logo_url), headerNoteHtml: a4HeaderNoteHtml(cfg) })}
        <div class="ttl">สลิปเงินเดือน<div class="sub">Payslip</div><div class="stt">เอกสารลับเฉพาะบุคคล</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">ชื่อพนักงาน</td><td>${esc(p.emp_name ?? '-')}</td><td class="lbl">งวด</td><td>${periodTh(p.period)}</td></tr>
        <tr><td class="lbl">รหัสพนักงาน</td><td>${esc(p.emp_code ?? '-')}</td><td class="lbl">ตำแหน่ง</td><td>${esc(p.position ?? '-')}</td></tr>
        <tr><td class="lbl">เลขบัตรประชาชน</td><td>${esc(p.national_id ?? '-')}</td><td class="lbl">แผนก</td><td>${esc(p.department ?? '-')}</td></tr>
        <tr><td class="lbl">วันที่จ่าย</td><td>${esc(thaiDate(p.pay_date))}</td><td class="lbl">เลขที่สลิป</td><td>#${esc(String(p.slip_id))}</td></tr>
      </table>
      <table class="grid">
        <thead><tr><th>รายได้ (Earnings)</th><th class="r">จำนวน</th><th>รายการหัก (Deductions)</th><th class="r">จำนวน</th></tr></thead>
        <tbody>
          <tr><td>เงินเดือน</td><td class="r">${fmtMoney(p.base)}</td><td>ลาไม่รับค่าจ้าง</td><td class="r">${p.unpaid ? fmtMoney(p.unpaid) : '-'}</td></tr>
          <tr><td>ค่าล่วงเวลา (OT)</td><td class="r">${p.ot_pay ? fmtMoney(p.ot_pay) : '-'}</td><td>ประกันสังคม</td><td class="r">${fmtMoney(p.sso_employee)}</td></tr>
          <tr><td></td><td class="r"></td><td>กองทุนสำรองเลี้ยงชีพ</td><td class="r">${p.pf_employee ? fmtMoney(p.pf_employee) : '-'}</td></tr>
          <tr><td></td><td class="r"></td><td>ภาษีหัก ณ ที่จ่าย (ภ.ง.ด.1)</td><td class="r">${p.wht ? fmtMoney(p.wht) : '-'}</td></tr>
          <tr class="grand"><td>รวมรายได้</td><td class="r">${fmtMoney(earnings)}</td><td>รวมรายการหัก</td><td class="r">${fmtMoney(deductions)}</td></tr>
        </tbody>
      </table>
      <table class="totals">
        <tr class="grand"><td class="tlbl">เงินได้สุทธิ (${ccy})</td><td class="tval">${fmtMoney(p.net)}</td></tr>
      </table>
      ${p.currency === 'THB' && cfg.totals.show_amount_in_words ? `<div class="words">( ${esc(bahtText(p.net))} )</div>` : ''}
      <div class="rmk">เงินสมทบนายจ้าง (ไม่หักจากพนักงาน): ประกันสังคม ${fmtMoney(p.sso_employer)}${p.pf_employer ? ` · กองทุนสำรองเลี้ยงชีพ ${fmtMoney(p.pf_employer)}` : ''} ${ccy}${p.entry_no ? ` &nbsp;·&nbsp; อ้างอิงบัญชี ${esc(p.entry_no)}` : ''}</div>
      ${a4FooterHtml(cfg, { leftDefault: 'ผู้จัดทำ (ฝ่ายบุคคล)', rightDefault: 'ผู้รับเงิน (พนักงาน)', rightWho: p.emp_name ?? '' })}
    `, 'สลิปเงินเดือน (Payslip)', { accentColor: cfg.header.accent_color });
  }
}

// Mask a citizen ID to the last 4 digits for the face of the slip (PDPA data-minimisation). Non-13-digit or
// empty input yields '-' so a legacy/partial value never leaks in full.
export function maskNationalId(v: string | null | undefined): string | null {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length < 4) return v ? 'x-xxxx-xxxxx-xx-x' : null;
  return `x-xxxx-xxxxx-xx-${d.slice(-1)} (…${d.slice(-4)})`;
}

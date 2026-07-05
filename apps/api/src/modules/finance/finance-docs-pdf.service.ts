import { Injectable } from '@nestjs/common';
import { bahtText } from '../../common/bahttext.util';
import { wrapA4, sellerHeaderHtml, esc, fmtMoney, thaiDate, formatTaxId, type DocParty } from '../../common/doc-html';
import { PdfRenderer } from '../pdf/pdf-renderer.service';

export interface StatementPrintData {
  party_type: 'customer' | 'vendor';
  party_name: string;
  party_tax_id: string | null;
  from: string; to: string;
  reporting_currency: string;
  opening_balance: number; total_charges: number; total_payments: number; closing_balance: number;
  lines: { date: string; type: string; ref: string; charge: number; payment: number; balance: number }[];
  seller: DocParty;
}

export interface ArReceiptPrintData {
  receipt_no: string; receipt_date: string | null; invoice_no: string | null;
  amount: number; method: string; ref_no: string | null; currency: string;
  customer: DocParty; seller: DocParty;
}

export interface DunningLetterPrintData {
  dunning_no: string; date: string | null; stage: string;
  invoice_no: string; invoice_date: string | null; outstanding: number; days_overdue: number;
  promise_to_pay_date: string | null; currency: string;
  customer: DocParty; seller: DocParty;
}

const TXN_TH: Record<string, string> = { invoice: 'ใบแจ้งหนี้', receipt: 'รับชำระ', bill: 'ตั้งหนี้', payment: 'จ่ายชำระ' };
const STAGE_TH: Record<string, string> = {
  reminder: 'แจ้งเตือน', first_notice: 'ทวงถามครั้งที่ 1', second_notice: 'ทวงถามครั้งที่ 2',
  final_notice: 'ทวงถามครั้งสุดท้าย', legal: 'ดำเนินคดี',
};

// HTML → PDF templates for the three finance documents that had no printable form: the statement of account
// (ใบแจ้งยอด, customer/vendor), the AR receipt voucher (ใบสำคัญรับเงิน) and the dunning/collection letter
// (จดหมายทวงถาม). Same shared shell + PdfRenderer (HTML fallback when Chromium absent).
@Injectable()
export class FinanceDocsPdfService {
  constructor(private readonly pdf: PdfRenderer) {}

  renderToPdf(html: string): Promise<Buffer | null> {
    return this.pdf.render(html, { format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
  }

  // ── ใบแจ้งยอด (Statement of account) ──
  statementHtml(s: StatementPrintData): string {
    const ccy = esc(s.reporting_currency || 'THB');
    const rows = s.lines.map((l) => `
      <tr><td>${esc(thaiDate(l.date))}</td><td>${esc(TXN_TH[l.type] ?? l.type)}</td><td>${esc(l.ref)}</td>
      <td class="r">${l.charge ? fmtMoney(l.charge) : ''}</td><td class="r">${l.payment ? fmtMoney(l.payment) : ''}</td>
      <td class="r">${fmtMoney(l.balance)}</td></tr>`).join('');
    const partyLabel = s.party_type === 'customer' ? 'ลูกค้า (ลูกหนี้)' : 'ผู้ขาย (เจ้าหนี้)';
    return wrapA4(`
      <div class="hdr">
        ${sellerHeaderHtml(s.seller)}
        <div class="ttl">ใบแจ้งยอดบัญชี<div class="sub">Statement of Account</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">${esc(partyLabel)}</td><td>${esc(s.party_name)}</td><td class="lbl">สกุลเงิน</td><td>${ccy}</td></tr>
        <tr><td class="lbl">เลขประจำตัวผู้เสียภาษี</td><td>${esc(s.party_tax_id ? formatTaxId(s.party_tax_id) : '-')}</td><td class="lbl">ช่วงเวลา</td><td>${esc(thaiDate(s.from))} – ${esc(thaiDate(s.to))}</td></tr>
      </table>
      <table class="grid">
        <thead><tr><th>วันที่</th><th>ประเภท</th><th>อ้างอิง</th><th class="r">ยอดเรียกเก็บ</th><th class="r">ชำระ/รับ</th><th class="r">คงเหลือ</th></tr></thead>
        <tbody>
          <tr><td colspan="5">ยอดยกมา (Opening balance)</td><td class="r">${fmtMoney(s.opening_balance)}</td></tr>
          ${rows}
          <tr class="grand"><td colspan="3">รวม</td><td class="r">${fmtMoney(s.total_charges)}</td><td class="r">${fmtMoney(s.total_payments)}</td><td class="r">${fmtMoney(s.closing_balance)}</td></tr>
        </tbody>
      </table>
      <div class="words">ยอดคงเหลือสุทธิ ${ccy} ${fmtMoney(s.closing_balance)}${s.reporting_currency === 'THB' ? ` ( ${esc(bahtText(s.closing_balance))} )` : ''}</div>
    `, 'ใบแจ้งยอดบัญชี (Statement)');
  }

  // ── ใบสำคัญรับเงิน (AR receipt voucher) ──
  arReceiptHtml(r: ArReceiptPrintData): string {
    const ccy = esc(r.currency || 'THB');
    return wrapA4(`
      <div class="hdr">
        ${sellerHeaderHtml(r.seller)}
        <div class="ttl">ใบสำคัญรับเงิน<div class="sub">Receipt Voucher</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">รับเงินจาก</td><td>${esc(r.customer.name)}</td><td class="lbl">เลขที่</td><td>${esc(r.receipt_no)}</td></tr>
        <tr><td class="lbl">อ้างอิงใบแจ้งหนี้</td><td>${esc(r.invoice_no ?? '-')}</td><td class="lbl">วันที่</td><td>${esc(thaiDate(r.receipt_date))}</td></tr>
        <tr><td class="lbl">วิธีชำระ</td><td>${esc(r.method)}${r.ref_no ? ` · ${esc(r.ref_no)}` : ''}</td><td class="lbl">สกุลเงิน</td><td>${ccy}</td></tr>
      </table>
      <table class="totals">
        <tr class="grand"><td class="tlbl">จำนวนเงินที่รับ (${ccy})</td><td class="tval">${fmtMoney(r.amount)}</td></tr>
      </table>
      ${r.currency === 'THB' ? `<div class="words">( ${esc(bahtText(r.amount))} )</div>` : ''}
      <div class="foot">
        <div class="sign">ผู้รับเงิน<div class="who"></div></div>
        <div class="sign">ผู้จ่ายเงิน (ลูกค้า)<div class="who"></div></div>
      </div>
    `, 'ใบสำคัญรับเงิน (Receipt)');
  }

  // ── จดหมายทวงถาม (Dunning / collection letter) ──
  dunningLetterHtml(d: DunningLetterPrintData): string {
    const ccy = esc(d.currency || 'THB');
    const stage = STAGE_TH[d.stage] ?? d.stage;
    const legalNote = d.stage === 'legal'
      ? 'บริษัทมีความจำเป็นต้องส่งเรื่องให้ฝ่ายกฎหมายดำเนินการตามกระบวนการต่อไป หากท่านไม่ชำระภายในกำหนด'
      : 'จึงเรียนมาเพื่อขอความอนุเคราะห์ให้ท่านชำระยอดค้างชำระข้างต้นภายใน 7 วันนับจากวันที่ในหนังสือฉบับนี้';
    return wrapA4(`
      <div class="hdr">
        ${sellerHeaderHtml(d.seller)}
        <div class="ttl">หนังสือทวงถามหนี้<div class="sub">Collection Letter</div><div class="stt">${esc(stage)}</div></div>
      </div>
      <table class="meta">
        <tr><td class="lbl">เรียน</td><td>${esc(d.customer.name)}</td><td class="lbl">เลขที่</td><td>${esc(d.dunning_no)}</td></tr>
        <tr><td class="lbl">ที่อยู่</td><td>${esc(d.customer.address ?? '-')}</td><td class="lbl">วันที่</td><td>${esc(thaiDate(d.date))}</td></tr>
      </table>
      <div class="rmk" style="margin-top:14px;line-height:1.8">
        <p>ตามที่บริษัทได้ออกใบแจ้งหนี้เลขที่ <b>${esc(d.invoice_no)}</b>${d.invoice_date ? ` ลงวันที่ ${esc(thaiDate(d.invoice_date))}` : ''} จำนวนเงินคงค้าง
        <b>${ccy} ${fmtMoney(d.outstanding)}</b> ( ${esc(bahtText(d.outstanding))} ) ซึ่งเกินกำหนดชำระมาแล้ว <b>${d.days_overdue}</b> วันนั้น</p>
        <p>${esc(legalNote)}</p>
        ${d.promise_to_pay_date ? `<p>ท่านได้แจ้งกำหนดชำระภายในวันที่ ${esc(thaiDate(d.promise_to_pay_date))}</p>` : ''}
        <p>หากท่านได้ชำระเรียบร้อยแล้ว ขอขอบคุณและโปรดละเว้นหนังสือฉบับนี้</p>
      </div>
      <div class="foot">
        <div class="sign">ผู้มีอำนาจลงนาม<div class="who">${esc(d.seller.name)}</div></div>
        <div class="sign"></div>
      </div>
    `, 'หนังสือทวงถามหนี้ (Dunning)');
  }
}

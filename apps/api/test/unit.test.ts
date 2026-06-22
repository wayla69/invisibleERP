import { describe, it, expect } from 'vitest';
import { ThaiTaxProvider, ZeroTaxProvider } from '../src/modules/tax/tax-providers';
import { TaxService } from '../src/modules/tax/tax.service';
import { round2, getCurrency, isSupportedCurrency } from '../src/modules/tax/money';
import { DocNumberService } from '../src/common/doc-number.service';
import { buildPromptPayPayload, crc16ccitt, isValidPromptPayTarget } from '../src/modules/payments/promptpay-qr';
import { socialSecurity, annualPit, computePayslip } from '../src/modules/payroll/payroll-calc';
import { buildEtaxInvoiceXml } from '../src/modules/tax-docs/etax-xml';
import { EtaxEmailService, ETAX_TIMESTAMP_EMAIL } from '../src/modules/tax-docs/etax-email.service';

describe('e-Tax by Email composer (ETDA, no CA)', () => {
  const svc = new EtaxEmailService(null as never, null as never, null as never);
  const inv = {
    doc_no: 'TIV-202606-0009', issue_date: '2026-06-22', currency: 'THB',
    seller: { name: 'ร้านโอชิเนอิ', tax_id: '0105551234567', address: 'กทม.' },
    buyer: { name: 'ลูกค้า' }, subtotal: 100, vat_rate: 0.07, vat_amount: 7, grand_total: 107,
    lines: [{ line_no: 1, description: 'อาหาร', amount: 100 }],
  };
  const msg = svc.compose(inv as never, 'shop@oshinei.co.th', 'buyer@example.com');
  it('CC goes to the ETDA time-stamp mailbox', () => expect(msg.cc).toBe(ETAX_TIMESTAMP_EMAIL));
  it('from seller → to buyer', () => { expect(msg.from).toBe('shop@oshinei.co.th'); expect(msg.to).toBe('buyer@example.com'); });
  it('subject carries the doc no', () => expect(msg.subject).toContain('TIV-202606-0009'));
  it('attaches the e-Tax XML', () => {
    expect(msg.attachments?.[0].filename).toBe('TIV-202606-0009.xml');
    expect(String(msg.attachments?.[0].content)).toContain('<Invoice ');
  });
});

describe('e-Tax Invoice XML (ETDA / UBL 2.1)', () => {
  const inv = {
    doc_no: 'TIV-202606-0001', type: 'full', issue_date: '2026-06-22', currency: 'THB',
    seller: { name: 'ร้าน A & B', tax_id: '0105551234567', branch_code: '00000', address: '1 ถนนสุข กทม.' },
    buyer: { name: 'ลูกค้า', tax_id: '0992001234567', branch_code: '00000', address: '2 ถนนดี' },
    subtotal: 100, vat_rate: 0.07, vat_amount: 7, grand_total: 107,
    lines: [{ line_no: 1, description: 'สินค้า <X>', qty: 2, uom: 'EA', unit_price: 50, amount: 100 }],
  };
  const xml = buildEtaxInvoiceXml(inv as never);
  it('declares XML + UBL Invoice root', () => {
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('<Invoice ');
    expect(xml).toContain('<cbc:UBLVersionID>2.1</cbc:UBLVersionID>');
  });
  it('carries doc id, dates, type 388, currency', () => {
    expect(xml).toContain('<cbc:ID>TIV-202606-0001</cbc:ID>');
    expect(xml).toContain('<cbc:IssueDate>2026-06-22</cbc:IssueDate>');
    expect(xml).toContain('>388</cbc:InvoiceTypeCode>');
    expect(xml).toContain('<cbc:DocumentCurrencyCode>THB</cbc:DocumentCurrencyCode>');
  });
  it('seller + buyer tax ids via PartyTaxScheme', () => {
    expect(xml).toContain('<cbc:CompanyID>0105551234567</cbc:CompanyID>');
    expect(xml).toContain('<cbc:CompanyID>0992001234567</cbc:CompanyID>');
  });
  it('tax total: 7% percent, taxable 100.00, tax 7.00; payable 107.00', () => {
    expect(xml).toContain('<cbc:Percent>7.00</cbc:Percent>');
    expect(xml).toContain('<cbc:TaxableAmount currencyID="THB">100.00</cbc:TaxableAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="THB">107.00</cbc:PayableAmount>');
  });
  it('line item + XML-escapes special chars', () => {
    expect(xml).toContain('<cac:InvoiceLine>');
    expect(xml).toContain('สินค้า &lt;X&gt;');     // < > escaped
    expect(xml).toContain('ร้าน A &amp; B');        // & escaped
    expect(xml).not.toContain('<X>');               // raw angle brackets must not leak
  });
});

describe('Payroll — Thai social security + PIT (ภ.ง.ด.1)', () => {
  it('SSO 5% capped at 750 (base ceiling 15,000)', () => {
    expect(socialSecurity(30000)).toEqual({ employee: 750, employer: 750 }); // capped
    expect(socialSecurity(10000)).toEqual({ employee: 500, employer: 500 }); // 5%
    expect(socialSecurity(12000)).toEqual({ employee: 600, employer: 600 });
    expect(socialSecurity(0)).toEqual({ employee: 0, employer: 0 });
    expect(socialSecurity(30000, false)).toEqual({ employee: 0, employer: 0 }); // not eligible
  });
  it('progressive annual PIT', () => {
    expect(annualPit(100000)).toBe(0);                 // under 150k
    expect(annualPit(191000)).toBe(2050);              // (191000-150000)*5%
    expect(annualPit(400000)).toBe(7500 + 10000);      // 150k@0 +150k@5%(7500) +100k@10%(10000) = 17500
  });
  it('payslip: 30,000 salary → SSO 750, WHT 170.83, net 29,079.17', () => {
    const s = computePayslip(30000);
    expect(s.gross).toBe(30000);
    expect(s.sso_employee).toBe(750);
    expect(s.sso_employer).toBe(750);
    expect(s.wht).toBe(170.83);                        // annual taxable 191k → 2050/12
    expect(s.net).toBe(29079.17);                      // 30000 - 750 - 170.83
  });
  it('payslip: low earner (12,000) → no WHT', () => {
    const s = computePayslip(12000);
    expect(s.sso_employee).toBe(600);
    expect(s.wht).toBe(0);                             // taxable below 150k
    expect(s.net).toBe(11400);                        // 12000 - 600
  });
});

describe('tax providers', () => {
  it('Thai VAT 7% on 100 = 7', () => {
    const r = new ThaiTaxProvider().calc({ net: 100 });
    expect(r.rate).toBe(0.07);
    expect(r.tax).toBe(7);
    expect(r.label).toContain('7');
  });
  it('Zero provider = 0', () => {
    expect(new ZeroTaxProvider().calc({ net: 999 }).tax).toBe(0);
  });
});

describe('TaxService (pluggable, no hard-coded VAT)', () => {
  const svc = new TaxService();
  it('resolves TH → VAT 7', () => expect(svc.calcTax({ net: 200, country: 'TH' }).tax).toBe(14));
  it('unknown country → zero (extensible registry)', () => expect(svc.calcTax({ net: 200, country: 'ZZ' }).tax).toBe(0));
});

describe('money / ISO-4217', () => {
  it('round2', () => expect(round2(1.239)).toBe(1.24));
  it('JPY has 0 minor units', () => expect(getCurrency('JPY').decimals).toBe(0));
  it('THB supported', () => expect(isSupportedCurrency('THB')).toBe(true));
});

describe('PromptPay QR (EMVCo)', () => {
  it('CRC16-CCITT standard check "123456789" → 29B1', () => expect(crc16ccitt('123456789')).toBe('29B1'));
  it('dynamic QR: header, AID, mobile-formatted, THB, amount, country, valid CRC', () => {
    const qr = buildPromptPayPayload('0801234567', 125.5);
    expect(qr.startsWith('000201')).toBe(true);     // payload format indicator
    expect(qr).toContain('010212');                 // dynamic (amount present)
    expect(qr).toContain('A000000677010111');       // PromptPay AID
    expect(qr).toContain('0066801234567');          // mobile → 0066 + number
    expect(qr).toContain('5303764');                // THB
    expect(qr).toContain('5406125.50');             // amount
    expect(qr).toContain('5802TH');                 // country
    expect(qr.slice(-4)).toBe(crc16ccitt(qr.slice(0, -4))); // CRC self-consistent
  });
  it('static QR (national ID, no amount): point-of-init 11, no amount tag', () => {
    const qr = buildPromptPayPayload('1234567890123');
    expect(qr).toContain('010211');                 // static
    expect(qr).not.toContain('5406');               // no amount tag
    expect(qr).toContain('02131234567890123');      // national-id sub-tag 02 + len 13
    expect(qr.slice(-4)).toBe(crc16ccitt(qr.slice(0, -4)));
  });
  it('target validation', () => {
    expect(isValidPromptPayTarget('0801234567')).toBe(true);
    expect(isValidPromptPayTarget('1234567890123')).toBe(true);
    expect(isValidPromptPayTarget('123')).toBe(false);
  });
});

describe('DocNumberService formats', () => {
  const d = new DocNumberService(undefined as never);
  it('sales order SO-YYYYMMDD-HHMM', () => expect(d.nextSalesOrder(new Date('2026-06-21T09:30:00'))).toMatch(/^SO-\d{8}-\d{4}$/));
  it('tenant-stamped SALE-prefix', () => expect(d.nextTenantStamped('SALE', 'Oshinei')).toMatch(/^SALE-OSHI-\d{14}$/));
});

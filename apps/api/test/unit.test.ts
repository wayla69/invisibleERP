import { describe, it, expect } from 'vitest';
import { ThaiTaxProvider, ZeroTaxProvider } from '../src/modules/tax/tax-providers';
import { TaxService } from '../src/modules/tax/tax.service';
import { round2, getCurrency, isSupportedCurrency } from '../src/modules/tax/money';
import { DocNumberService } from '../src/common/doc-number.service';
import { buildPromptPayPayload, crc16ccitt, isValidPromptPayTarget } from '../src/modules/payments/promptpay-qr';

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

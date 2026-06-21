import { describe, it, expect } from 'vitest';
import { ThaiTaxProvider, ZeroTaxProvider } from '../src/modules/tax/tax-providers';
import { TaxService } from '../src/modules/tax/tax.service';
import { round2, getCurrency, isSupportedCurrency } from '../src/modules/tax/money';
import { DocNumberService } from '../src/common/doc-number.service';

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

describe('DocNumberService formats', () => {
  const d = new DocNumberService(undefined as never);
  it('sales order SO-YYYYMMDD-HHMM', () => expect(d.nextSalesOrder(new Date('2026-06-21T09:30:00'))).toMatch(/^SO-\d{8}-\d{4}$/));
  it('tenant-stamped SALE-prefix', () => expect(d.nextTenantStamped('SALE', 'Oshinei')).toMatch(/^SALE-OSHI-\d{14}$/));
});

// Unit-pyramid extension (2.4): the pure Thai-tax rule modules — VAT tax-point (ม.78/78-1) and WHT
// rate/ภ.ง.ด. routing (ม.40 / ท.ป.4/2528). Both are compliance-load-bearing lookup/decision tables with
// zero dependencies; tax-point.ts was already inside the coverage glob but untested until this suite.
import { describe, expect, it } from 'vitest';
import { resolveTaxPoint, resolveInstallmentTaxPoints } from '../src/modules/tax/tax-point';
import { incomeType, defaultWhtRate, resolvePnd, isAllowedWhtRate, WHT_INCOME_TYPES } from '../src/modules/tax/documents/wht-rates';

describe('resolveTaxPoint (ม.78 / ม.78/1 earliest-of)', () => {
  it('goods: default tax point is delivery', () => {
    expect(resolveTaxPoint({ supplyType: 'goods', invoiceDate: '2026-07-10', deliveryDate: '2026-07-08' })).toBe('2026-07-08');
  });

  it('goods: an earlier payment (advance that is consideration) pulls the tax point forward', () => {
    expect(resolveTaxPoint({ supplyType: 'goods', invoiceDate: '2026-07-10', deliveryDate: '2026-07-08', paymentDate: '2026-07-01' })).toBe('2026-07-01');
  });

  it('goods: transfer-of-ownership before delivery wins', () => {
    expect(resolveTaxPoint({ supplyType: 'goods', invoiceDate: '2026-07-10', deliveryDate: '2026-07-09', transferDate: '2026-07-05' })).toBe('2026-07-05');
  });

  it('goods: with only the invoice, the invoice date is the tax point', () => {
    expect(resolveTaxPoint({ supplyType: 'goods', invoiceDate: '2026-07-10' })).toBe('2026-07-10');
  });

  it('service: default tax point is payment, not the invoice', () => {
    expect(resolveTaxPoint({ supplyType: 'service', invoiceDate: '2026-07-01', paymentDate: '2026-07-15' })).toBe('2026-07-01'); // invoice earlier → invoice
    expect(resolveTaxPoint({ supplyType: 'service', invoiceDate: '2026-07-20', paymentDate: '2026-07-15' })).toBe('2026-07-15'); // payment earlier → payment
  });

  it('service: service-used before payment pulls the tax point forward; deliveryDate is ignored for services', () => {
    expect(resolveTaxPoint({ supplyType: 'service', invoiceDate: '2026-07-20', paymentDate: '2026-07-15', serviceUsedDate: '2026-07-10', deliveryDate: '2026-07-01' })).toBe('2026-07-10');
  });

  it('installments (ม.78(2)): one tax point per instalment due date, ordered, blanks dropped', () => {
    expect(resolveInstallmentTaxPoints(['2026-09-01', null, '2026-07-01', undefined, '2026-08-01', ''])).toEqual(['2026-07-01', '2026-08-01', '2026-09-01']);
  });
});

describe('wht-rates (ม.40 / 3 เตรส lookup + ภ.ง.ด. routing)', () => {
  it('standard rates: services 3%, rent 5%, interest 15% person / 1% company, dividend 10%', () => {
    expect(defaultWhtRate('40(7-8)', 'company')).toBe(0.03);
    expect(defaultWhtRate('40(5)', 'person')).toBe(0.05);
    expect(defaultWhtRate('40(4a)', 'person')).toBe(0.15);
    expect(defaultWhtRate('40(4a)', 'company')).toBe(0.01);
    expect(defaultWhtRate('40(4b)', 'company')).toBe(0.1);
  });

  it('salary (progressive) and "other" have no fixed standard rate', () => {
    expect(defaultWhtRate('40(1)', 'person')).toBeUndefined();
    expect(defaultWhtRate('other', 'company')).toBeUndefined();
    expect(defaultWhtRate('no-such-code', 'person')).toBeUndefined();
  });

  it('resolvePnd: salary → ภ.ง.ด.1ก; company → ภ.ง.ด.53; person interest/royalty → ภ.ง.ด.2; person services → ภ.ง.ด.3', () => {
    expect(resolvePnd('40(1)', 'person')).toBe('PND1K');
    expect(resolvePnd('40(7-8)', 'company')).toBe('PND53');
    expect(resolvePnd('40(4a)', 'person')).toBe('PND2');
    expect(resolvePnd('40(3)', 'person')).toBe('PND2');
    expect(resolvePnd('40(5)', 'person')).toBe('PND3');
    expect(resolvePnd('unknown-code', 'person')).toBe('PND3'); // defaults to service group
  });

  it('isAllowedWhtRate: standard rate ok, common alternates ok, nonsense rejected', () => {
    expect(isAllowedWhtRate('40(7-8)', 'company', 0.03)).toBe(true);
    expect(isAllowedWhtRate('40(7-8)', 'company', 0.01)).toBe(true);   // e-WHT reduced promo
    expect(isAllowedWhtRate('40(4a)', 'person', 0.15)).toBe(true);
    expect(isAllowedWhtRate('40(7-8)', 'company', 0.07)).toBe(false);  // not standard, not an alternate
    expect(isAllowedWhtRate('40(1)', 'person', 0.12)).toBe(true);      // no fixed standard → bounded trust
    expect(isAllowedWhtRate('40(1)', 'person', 0)).toBe(false);
    expect(isAllowedWhtRate('40(1)', 'person', 0.5)).toBe(false);      // > 30% cap
  });

  it('table shape: unique codes; 3 เตรส rows require a description', () => {
    expect(new Set(WHT_INCOME_TYPES.map((t) => t.code)).size).toBe(WHT_INCOME_TYPES.length);
    expect(incomeType('3tre-ad')?.requiresDesc).toBe(true);
    expect(incomeType('3tre-transport')?.rate.company).toBe(0.01);
  });
});

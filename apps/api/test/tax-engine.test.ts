import { describe, expect, it } from 'vitest';

import { CURRENCIES, getCurrency, isSupportedCurrency, money, round2, roundCurrency } from '../src/modules/tax/money';
import { EuTaxProvider, MyTaxProvider, SgTaxProvider, ThaiTaxProvider, ZeroTaxProvider } from '../src/modules/tax/tax-providers';
import { TaxService } from '../src/modules/tax/tax.service';

// Unit tests for the country-keyed tax engine (2.4 slice 9 — the pure-tier lift): the ISO-4217
// minor-unit money helpers, every registered TaxProvider, and the TaxService registry/calc/inclusive/
// per-tenant paths. TaxService's DRIZZLE is @Optional, so `new TaxService()` is the real no-DB shape.

describe('tax/money — ISO-4217 minor units (JPY 0dp is the trap)', () => {
  it('getCurrency is case-insensitive and falls back to THB for unknown/empty codes', () => {
    expect(getCurrency('jpy')).toMatchObject({ code: 'JPY', decimals: 0, symbol: '¥' });
    expect(getCurrency('XXX').code).toBe('THB');
    expect(getCurrency('').code).toBe('THB');
    expect(getCurrency().code).toBe('THB');
  });

  it('isSupportedCurrency mirrors the catalogue', () => {
    expect(isSupportedCurrency('usd')).toBe(true);
    expect(isSupportedCurrency('XXX')).toBe(false);
    expect(isSupportedCurrency('')).toBe(false);
  });

  it('roundCurrency rounds to the currency minor unit — a blanket 2dp would drift JPY', () => {
    expect(roundCurrency(1.005, 'THB')).toBe(1.01);   // epsilon-corrected half-cent
    expect(roundCurrency(123.4, 'JPY')).toBe(123);    // no sub-yen
    expect(roundCurrency(123.5, 'JPY')).toBe(124);
    expect(round2(1.239)).toBe(1.24);
  });

  it('money() snapshots value + integer minor units + display text per currency', () => {
    expect(money(99.999)).toEqual({ amount: 100, currency: 'THB', decimals: 2, symbol: '฿', minor: 10000, text: '฿100.00' });
    expect(money(1234.4, 'JPY')).toEqual({ amount: 1234, currency: 'JPY', decimals: 0, symbol: '¥', minor: 1234, text: '¥1234' });
  });
});

describe('tax-providers — per-country calc (net → rate/tax/label)', () => {
  it('TH: 7% VAT; a per-tenant override (incl. an explicit 0) replaces it; a negative override is ignored', () => {
    const th = new ThaiTaxProvider();
    expect(th.calc({ net: 100 })).toEqual({ rate: 0.07, tax: 7, label: 'VAT 7%' });
    expect(th.calc({ net: 100, rate: 0.1 })).toEqual({ rate: 0.1, tax: 10, label: 'VAT 10%' });
    expect(th.calc({ net: 100, rate: 0 })).toEqual({ rate: 0, tax: 0, label: 'VAT 0%' });
    expect(th.calc({ net: 100, rate: -1 }).rate).toBe(0.07); // nonsense override → provider default
    expect(th.calc({ net: 1001, currency: 'JPY' }).tax).toBe(70); // rounded to the currency minor unit
  });

  it('SG 9% GST · MY 6% SST with the food/basic-essential exemption · EU parametric · Zero fallback', () => {
    expect(new SgTaxProvider().calc({ net: 100 })).toEqual({ rate: 0.09, tax: 9, label: 'GST 9%' });
    const my = new MyTaxProvider();
    expect(my.calc({ net: 100 })).toEqual({ rate: 0.06, tax: 6, label: 'SST 6%' });
    expect(my.calc({ net: 100, category: 'food' })).toEqual({ rate: 0, tax: 0, label: 'SST Exempt' });
    expect(my.calc({ net: 100, category: 'basic_essential' }).tax).toBe(0);
    expect(new EuTaxProvider().calc({ net: 100 })).toEqual({ rate: 0.2, tax: 20, label: 'VAT 20%' });
    const de = new EuTaxProvider('DE', 0.19);
    expect(de.country).toBe('DE');
    expect(de.calc({ net: 100 }).tax).toBe(19);
    expect(new ZeroTaxProvider().calc({ net: 999 })).toEqual({ rate: 0, tax: 0, label: 'No Tax' });
  });
});

describe('TaxService — registry / calcTax / VAT-inclusive back-out', () => {
  it('resolves case-insensitively, falls back to ZeroTax for unsupported countries, and accepts adapters', () => {
    const svc = new TaxService();
    expect(svc.supportedCountries()).toEqual(['TH', 'SG', 'MY', 'EU']);
    expect(svc.resolveProvider('sg').country).toBe('SG');
    expect(svc.resolveProvider('US').calc({ net: 100 })).toEqual({ rate: 0, tax: 0, label: 'No Tax' }); // unsupported → zero-rated
    expect(svc.resolveProvider().country).toBe('TH'); // default
    svc.register(new EuTaxProvider('DE', 0.19)); // Avalara/Stripe-Tax adapters register the same way
    expect(svc.resolveProvider('de').calc({ net: 100 }).tax).toBe(19);
    expect(svc.supportedCountries()).toContain('DE');
    expect(svc.currencies()).toBe(CURRENCIES);
  });

  it('calcTax defaults to TH/THB and rounds net/tax/gross in the request currency', () => {
    const svc = new TaxService();
    expect(svc.calcTax({ net: 100 })).toEqual({ country: 'TH', net: 100, rate: 0.07, tax: 7, gross: 107, label: 'VAT 7%', currency: 'THB' });
    expect(svc.calcTax({ net: 100, country: 'my', category: 'food' })).toMatchObject({ country: 'MY', tax: 0, gross: 100, label: 'SST Exempt' });
    expect(svc.calcTax({ net: 1001, currency: 'jpy' })).toMatchObject({ currency: 'JPY', net: 1001, tax: 70, gross: 1071 });
  });

  it('calcInclusive backs the tax out of a gross amount: tax = gross×rate/(1+rate) (ม.86/6 abbreviated invoices)', () => {
    const svc = new TaxService();
    expect(svc.calcInclusive({ gross: 107 })).toEqual({ country: 'TH', rate: 0.07, net: 100, tax: 7, gross: 107, currency: 'THB' });
    expect(svc.calcInclusive({ gross: 100, rate: 0 })).toMatchObject({ net: 100, tax: 0 }); // zero-rated → nothing to back out
  });
});

describe('TaxService — per-tenant VAT config (0044, cached)', () => {
  const chain = (rows: any[]) => {
    const p: any = { from: () => p, where: () => p, limit: () => p, then: (r: any, j: any) => Promise.resolve(rows).then(r, j) };
    return p;
  };
  function tenantDb(routes: any[][]) {
    let call = 0;
    return { select: () => { if (call >= routes.length) throw new Error(`unexpected select #${call + 1}`); return chain(routes[call++] ?? []); } };
  }

  it('without a DB the config defaults to TH 7% (callers without a tenant are unchanged)', async () => {
    const svc = new TaxService();
    expect(await svc.tenantTaxConfig(1)).toEqual({ rate: 0.07, country: 'TH' });
    const r = await svc.calcTaxForTenant(1, { net: 100 });
    expect(r).toMatchObject({ country: 'TH', tax: 7 });
  });

  it('reads the tenant row ONCE (cache), and invalidateTenantTax forces a re-read', async () => {
    // strict routes: exactly two selects across three calls — the middle call must hit the cache
    const svc = new TaxService(tenantDb([
      [{ vatRate: '0.10', taxCountry: 'sg' }],
      [{ vatRate: '0.07', taxCountry: 'th' }],
    ]) as any);
    expect(await svc.tenantTaxConfig(9)).toEqual({ rate: 0.1, country: 'SG' });
    expect(await svc.tenantTaxConfig(9)).toEqual({ rate: 0.1, country: 'SG' }); // cached — no select
    svc.invalidateTenantTax(9);
    expect(await svc.tenantTaxConfig(9)).toEqual({ rate: 0.07, country: 'TH' });
  });

  it('calcInclusiveForTenant applies the tenant rate+country to the back-out', async () => {
    const svc = new TaxService(tenantDb([[{ vatRate: '0.10', taxCountry: 'sg' }]]) as any);
    const r = await svc.calcInclusiveForTenant(9, { gross: 110 });
    expect(r).toEqual({ country: 'SG', rate: 0.1, net: 100, tax: 10, gross: 110, currency: 'THB' });
  });
});

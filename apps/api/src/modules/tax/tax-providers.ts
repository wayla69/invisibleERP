// tax-providers.ts — pluggable per-country tax calculation.
//
// A TaxProvider turns a NET (tax-exclusive) amount into { rate, tax, label }.
// Adapters for Avalara / Stripe Tax / EU MOSS can implement the same interface
// and register into TaxService's Map<country, provider> without touching callers.

import { roundCurrency } from './money';

export interface TaxInput {
  net: number; // tax-exclusive base amount
  category?: string; // optional product/service category (for category-specific rates)
  date?: string; // optional YYYY-MM-DD effective date (for rate changes over time)
  currency?: string; // ISO-4217 (default 'THB') — controls minor-unit rounding of tax (JPY=0dp)
}

export interface TaxResult {
  rate: number; // decimal rate applied (0.07 = 7%)
  tax: number; // computed tax amount
  label: string; // human label, e.g. 'VAT 7%'
}

export interface TaxProvider {
  country: string; // ISO-3166 alpha-2
  calc(input: TaxInput): TaxResult;
}

// Thailand — standard 7% VAT.
export class ThaiTaxProvider implements TaxProvider {
  readonly country = 'TH';
  private readonly rate = 0.07;
  private readonly label = 'VAT 7%';

  calc(input: TaxInput): TaxResult {
    const net = Number(input?.net) || 0;
    const currency = input?.currency ?? 'THB';
    return { rate: this.rate, tax: roundCurrency(net * this.rate, currency), label: this.label };
  }
}

// Fallback — zero-rated / tax-exempt / unsupported country.
export class ZeroTaxProvider implements TaxProvider {
  readonly country: string;
  constructor(country = 'XX') {
    this.country = country;
  }

  calc(_input: TaxInput): TaxResult {
    return { rate: 0, tax: 0, label: 'No Tax' };
  }
}

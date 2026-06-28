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
  rate?: number; // optional per-tenant rate override (decimal, 0.07 = 7%) — provider default if omitted
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

// Thailand — standard 7% VAT, or a per-tenant override rate when provided.
export class ThaiTaxProvider implements TaxProvider {
  readonly country = 'TH';
  private readonly rate = 0.07;

  calc(input: TaxInput): TaxResult {
    const net = Number(input?.net) || 0;
    const currency = input?.currency ?? 'THB';
    const rate = input?.rate != null && input.rate >= 0 ? input.rate : this.rate;
    return { rate, tax: roundCurrency(net * rate, currency), label: `VAT ${+(rate * 100).toFixed(2)}%` };
  }
}

// Singapore — 9% GST (Goods and Services Tax, effective 1 Jan 2024).
export class SgTaxProvider implements TaxProvider {
  readonly country = 'SG';
  private readonly rate = 0.09;

  calc(input: TaxInput): TaxResult {
    const net = Number(input?.net) || 0;
    const currency = input?.currency ?? 'SGD';
    const rate = input?.rate != null && input.rate >= 0 ? input.rate : this.rate;
    return { rate, tax: roundCurrency(net * rate, currency), label: `GST ${+(rate * 100).toFixed(2)}%` };
  }
}

// Malaysia — 6% SST (Sales and Service Tax). Food/beverage category is exempt (0%).
export class MyTaxProvider implements TaxProvider {
  readonly country = 'MY';
  private readonly rate = 0.06;

  calc(input: TaxInput): TaxResult {
    const net = Number(input?.net) || 0;
    const currency = input?.currency ?? 'MYR';
    // Food, basic essentials and certain services are SST-exempt in Malaysia.
    if (input?.category === 'food' || input?.category === 'basic_essential') {
      return { rate: 0, tax: 0, label: 'SST Exempt' };
    }
    const rate = input?.rate != null && input.rate >= 0 ? input.rate : this.rate;
    return { rate, tax: roundCurrency(net * rate, currency), label: `SST ${+(rate * 100).toFixed(2)}%` };
  }
}

// EU / Generic — 20% VAT (representative standard rate; actual rate varies per member state).
// Register country-specific providers (e.g. 'DE', 'FR') to override for individual states.
export class EuTaxProvider implements TaxProvider {
  readonly country: string;
  private readonly rate: number;

  constructor(country = 'EU', rate = 0.20) {
    this.country = country;
    this.rate = rate;
  }

  calc(input: TaxInput): TaxResult {
    const net = Number(input?.net) || 0;
    const currency = input?.currency ?? 'EUR';
    const rate = input?.rate != null && input.rate >= 0 ? input.rate : this.rate;
    return { rate, tax: roundCurrency(net * rate, currency), label: `VAT ${+(rate * 100).toFixed(2)}%` };
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

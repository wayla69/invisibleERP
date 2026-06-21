import { Inject, Injectable, Optional } from '@nestjs/common';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import {
  type TaxProvider,
  type TaxInput,
  type TaxResult,
  ThaiTaxProvider,
  ZeroTaxProvider,
} from './tax-providers';
import { CURRENCIES, getCurrency, roundCurrency } from './money';

export interface CalcTaxInput extends TaxInput {
  country?: string; // ISO-3166 alpha-2 (default 'TH')
  currency?: string; // ISO-4217 (default 'THB') — for display/rounding context
}

export interface CalcTaxResult extends TaxResult {
  country: string;
  net: number;
  gross: number; // net + tax
  currency: string;
}

/**
 * TaxService — country-keyed registry of TaxProviders.
 *
 * resolveProvider('TH') → ThaiTaxProvider; any other / unknown → ZeroTaxProvider.
 * DRIZZLE is injected optionally so future providers can read DB-backed rate
 * tables (e.g. fiscalPeriods, per-tenant exemptions) — current providers don't.
 * Register Avalara/Stripe-Tax adapters via register(provider).
 */
@Injectable()
export class TaxService {
  private readonly providers = new Map<string, TaxProvider>();
  private readonly fallback = new ZeroTaxProvider();

  constructor(@Optional() @Inject(DRIZZLE) private readonly db?: DrizzleDb) {
    this.register(new ThaiTaxProvider());
  }

  register(provider: TaxProvider): void {
    this.providers.set(provider.country.toUpperCase(), provider);
  }

  resolveProvider(country = 'TH'): TaxProvider {
    return this.providers.get((country || 'TH').toUpperCase()) ?? this.fallback;
  }

  // List supported (registered) country codes.
  supportedCountries(): string[] {
    return [...this.providers.keys()];
  }

  calcTax(input: CalcTaxInput): CalcTaxResult {
    const country = (input?.country || 'TH').toUpperCase();
    const currency = getCurrency(input?.currency).code;
    const net = Number(input?.net) || 0;
    const provider = this.resolveProvider(country);
    const { rate, tax, label } = provider.calc({ net, category: input?.category, date: input?.date, currency });
    return {
      country,
      net: roundCurrency(net, currency),
      rate,
      tax: roundCurrency(tax, currency),
      gross: roundCurrency(net + tax, currency),
      label,
      currency,
    };
  }

  // VAT-inclusive back-out: a gross amount (price incl. VAT) → { net, tax, gross }.
  // Used by abbreviated tax invoices (ม.86/6) and AR amounts stored VAT-inclusive. tax = gross×rate/(1+rate).
  calcInclusive(input: { gross: number; country?: string; currency?: string }): { country: string; rate: number; net: number; tax: number; gross: number; currency: string } {
    const country = (input?.country || 'TH').toUpperCase();
    const currency = getCurrency(input?.currency).code;
    const gross = Number(input?.gross) || 0;
    const { rate } = this.resolveProvider(country).calc({ net: 0, currency });
    const tax = roundCurrency((gross * rate) / (1 + rate), currency);
    return { country, rate, net: roundCurrency(gross - tax, currency), tax, gross: roundCurrency(gross, currency), currency };
  }

  // Currency catalogue passthrough (for the /currencies endpoint).
  currencies() {
    return CURRENCIES;
  }
}

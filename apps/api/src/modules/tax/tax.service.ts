import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { tenants } from '../../database/schema';
import {
  type TaxProvider,
  type TaxInput,
  type TaxResult,
  ThaiTaxProvider,
  SgTaxProvider,
  MyTaxProvider,
  EuTaxProvider,
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
    this.register(new SgTaxProvider());
    this.register(new MyTaxProvider());
    this.register(new EuTaxProvider('EU', 0.20)); // generic EU — 20% standard rate placeholder
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
    const { rate, tax, label } = provider.calc({ net, category: input?.category, date: input?.date, currency, rate: input?.rate });
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
  calcInclusive(input: { gross: number; country?: string; currency?: string; rate?: number }): { country: string; rate: number; net: number; tax: number; gross: number; currency: string } {
    const country = (input?.country || 'TH').toUpperCase();
    const currency = getCurrency(input?.currency).code;
    const gross = Number(input?.gross) || 0;
    const { rate } = this.resolveProvider(country).calc({ net: 0, currency, rate: input?.rate });
    const tax = roundCurrency((gross * rate) / (1 + rate), currency);
    return { country, rate, net: roundCurrency(gross - tax, currency), tax, gross: roundCurrency(gross, currency), currency };
  }

  // ── Per-tenant VAT (0044) ──
  // Resolve a tenant's configured rate + country (cached) and apply it. Defaults to TH 7% when the
  // tenant or columns are absent, so callers that don't yet pass a tenant are unchanged.
  private readonly tenantTaxCache = new Map<number, { rate: number; country: string }>();

  async tenantTaxConfig(tenantId: number): Promise<{ rate: number; country: string }> {
    const hit = this.tenantTaxCache.get(tenantId);
    if (hit) return hit;
    let cfg = { rate: 0.07, country: 'TH' };
    if (this.db) {
      const [t] = await this.db.select({ vatRate: tenants.vatRate, taxCountry: tenants.taxCountry })
        .from(tenants).where(eq(tenants.id, tenantId)).limit(1);
      if (t) cfg = { rate: t.vatRate != null ? Number(t.vatRate) : 0.07, country: (t.taxCountry || 'TH').toUpperCase() };
    }
    this.tenantTaxCache.set(tenantId, cfg);
    return cfg;
  }

  // call after a tenant's vat_rate/tax_country changes (e.g. setup wizard) to drop the stale cache entry
  invalidateTenantTax(tenantId: number): void {
    this.tenantTaxCache.delete(tenantId);
  }

  async calcTaxForTenant(tenantId: number, input: CalcTaxInput): Promise<CalcTaxResult> {
    const { rate, country } = await this.tenantTaxConfig(tenantId);
    return this.calcTax({ ...input, rate: input?.rate ?? rate, country: input?.country ?? country });
  }

  async calcInclusiveForTenant(tenantId: number, input: { gross: number; currency?: string }): Promise<{ country: string; rate: number; net: number; tax: number; gross: number; currency: string }> {
    const { rate, country } = await this.tenantTaxConfig(tenantId);
    return this.calcInclusive({ ...input, rate, country });
  }

  // Currency catalogue passthrough (for the /currencies endpoint).
  currencies() {
    return CURRENCIES;
  }
}

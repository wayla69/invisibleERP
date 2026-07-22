import { and, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import type { ScmSeriesRegressor } from '@ierp/shared';
import type { DrizzleDb } from '../../database/database.module';
import { items, promotions } from '../../database/schema';
import { addDaysYmd } from '../demand-ml/forecast-algorithms';

// docs/56 A1 — SERVER-DERIVED promo/price regressors (control SCM-04).
//
// The forecast promo signal is assembled here, from GOVERNED tables only — the tenant's approved
// `promotions` (date-ranged, active, category-scoped) — and NEVER from the run request body. A run
// therefore cannot assert a promo that does not exist in the governed data: a fabricated promo flag
// has no way in. Built positionally in the ScmExtractService ctor (db-only sub-service), like the
// stock extractor.
//
// Scope note: `promotions` is category-scoped (or all-items) and tenant-wide (no branch column), so a
// promo regressor is the same across a menu sku's branch series. A1 carries the promo_flag + discount
// depth (the headline demand lever); docs/56 A2 adds a GOVERNED effective PRICE per day (base price ×
// (1 − discount)), so a promotion's price cut becomes the price variation the engine's log-log
// elasticity estimator needs — still server-derived, never from the request body.
export class ScmPromoExtractService {
  constructor(private readonly db: DrizzleDb) {}

  /**
   * Per menu-sku promo regressors over [fromDay, toDay] (business days), derived from active
   * governed promotions whose category matches the sku (or that apply to all items). Sparse: only
   * promo-active days are emitted; the engine treats a missing day as no-promo (baseline).
   */
  async regressorsFor(
    tenantId: number | null,
    skus: string[],
    fromDay: string,
    toDay: string,
  ): Promise<Map<string, ScmSeriesRegressor[]>> {
    const out = new Map<string, ScmSeriesRegressor[]>();
    if (!skus.length) return out;

    // Active promotions overlapping the window (a null start/end is treated as open-ended).
    const promos = await this.db.select({
      startDate: promotions.startDate,
      endDate: promotions.endDate,
      discountPct: promotions.discountPct,
      category: promotions.category,
    }).from(promotions).where(and(
      tenantId != null ? eq(promotions.tenantId, tenantId) : sql`true`,
      sql`coalesce(${promotions.active}, true) = true`,
      or(sql`${promotions.endDate} is null`, gte(promotions.endDate, fromDay)),
      or(sql`${promotions.startDate} is null`, lte(promotions.startDate, toDay)),
    ));
    if (!promos.length) return out;

    // sku → category + base price (shared `items` master has no tenant_id; category is free-text).
    const itemRows = await this.db.select({ itemId: items.itemId, category: items.category, unitPrice: items.unitPrice })
      .from(items).where(inArray(items.itemId, skus));
    const catBySku = new Map(itemRows.map((r) => [r.itemId, (r.category ?? '').trim()]));
    const priceBySku = new Map(itemRows.map((r) => [r.itemId, r.unitPrice != null ? Number(r.unitPrice) : 0]));

    const allDays = this.daysBetween(fromDay, toDay);
    const isAll = (c: string | null) => !c || c.trim() === '' || c.trim().toLowerCase() === 'all';

    for (const sku of skus) {
      const cat = catBySku.get(sku) ?? '';
      const basePrice = priceBySku.get(sku) ?? 0;
      const rows: ScmSeriesRegressor[] = [];
      for (const day of allDays) {
        // The strongest matching promo for this (sku, day): all-items or same-category, in range.
        let best: number | null = null;
        for (const p of promos) {
          const applies = isAll(p.category) || (cat !== '' && p.category?.trim() === cat);
          if (!applies) continue;
          if (p.startDate && day < p.startDate) continue;
          if (p.endDate && day > p.endDate) continue;
          const pct = p.discountPct != null ? Math.min(1, Math.max(0, Number(p.discountPct) / 100)) : 0;
          best = best == null ? pct : Math.max(best, pct);
        }
        // A2: emit the effective price on EVERY day (baseline off-promo, discounted on-promo) when the
        // base price is known — that promo-driven variation is what identifies the elasticity. When no
        // base price exists, keep the A1 sparse promo-only rows (no price signal to give).
        if (basePrice > 0) {
          const price = best != null ? basePrice * (1 - best) : basePrice;
          rows.push({ ds: day, promo_flag: best != null, discount_pct: best ?? undefined, price: Number(price.toFixed(4)) });
        } else if (best != null) {
          rows.push({ ds: day, promo_flag: true, discount_pct: best });
        }
      }
      if (rows.length) out.set(sku, rows);
    }
    return out;
  }

  private daysBetween(fromDay: string, toDay: string): string[] {
    const days: string[] = [];
    for (let d = fromDay; d <= toDay; d = addDaysYmd(d, 1)) {
      days.push(d);
      if (days.length > 1200) break; // hard bound (lookback 1095 + horizon) — never unbounded
    }
    return days;
  }
}

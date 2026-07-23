import { and, eq, sql } from 'drizzle-orm';
import type { ScmSeriesRegressor } from '@ierp/shared';
import type { DrizzleDb } from '../../database/database.module';
import { scmCrossElasticity } from '../../database/schema';
import { addDaysYmd } from '../demand-ml/forecast-algorithms';
import type { DenseSeries } from './scm-planning.types';

// docs/56 Track A (A3) — CATEGORY-SCOPED cross-price elasticity (cannibalization / halo).
//
// γ_{a,b} = the slope of item_a's log-demand on item_b's log-price, estimated API-side from the same
// governed data a run already extracts (per-item demand + the server-derived effective price). It is
// computed ONLY for sibling pairs sharing an item_categories category — never the full cross-product —
// and gated by the SAME identifiability floor as the own-price elasticity (A2), so a spurious cross
// term is never emitted. A credible γ>0 = substitutes (a promo on b cannibalizes a); γ<0 = complements
// (a promo on b lifts a / halo). Persisted per (tenant, item_a, item_b), read by the advisory scenario
// tool. Tenant-scoped (RLS + explicit filter); server-derived, never client input.
//
// db-only sub-service, built positionally in the ScmPlanningService ctor (the scm-elasticity/-hierarchy
// precedent) so the facade stays under the check-service-size cap.

const MIN_OBS = 8;
const MIN_LOGPRICE_VAR = 1e-4;
const MIN_R2 = 0.05;
const CLAMP = 5;
const MAX_CATEGORY_ITEMS = 24; // O(n²) pairs — skip pathologically large categories (safety bound)
const CACHE_TTL_MS = 60_000;

export interface CrossRow {
  itemA: string;
  itemB: string;
  category: string | null;
  gamma: number;
  r2: number | null;
  nObs: number;
}

/**
 * Pure log-log OLS of demand_a on price_b over aligned days. Returns (γ, r², nObs); γ is null (not
 * identified) unless the floor holds: enough paired days, real price movement, and a credible fit.
 * Days with demand_a ≤ 0 or a missing/≤0 price_b are dropped (they carry no ratio).
 */
export function estimateCrossElasticity(
  demandA: Map<string, number>,
  priceB: Map<string, number>,
): { gamma: number | null; r2: number | null; nObs: number } {
  const xs: number[] = []; // log price_b
  const ys: number[] = []; // log demand_a
  for (const [ds, dA] of demandA) {
    if (!(dA > 0)) continue;
    const pB = priceB.get(ds);
    if (pB == null || !(pB > 0)) continue;
    xs.push(Math.log(pB));
    ys.push(Math.log(dA));
  }
  const n = xs.length;
  if (n < MIN_OBS) return { gamma: null, r2: null, nObs: n };
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let varX = 0, varY = 0, covXY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    varX += dx * dx; varY += dy * dy; covXY += dx * dy;
  }
  varX /= n; varY /= n; covXY /= n;
  if (varX < MIN_LOGPRICE_VAR) return { gamma: null, r2: null, nObs: n };
  const beta = covXY / varX;
  const r2 = varY > 0 ? (covXY * covXY) / (varX * varY) : 0;
  if (r2 < MIN_R2) return { gamma: null, r2: Math.round(r2 * 1e4) / 1e4, nObs: n };
  const gamma = Math.max(-CLAMP, Math.min(CLAMP, beta));
  return { gamma: Math.round(gamma * 1e4) / 1e4, r2: Math.round(r2 * 1e4) / 1e4, nObs: n };
}

export class ScmCrossElasticityService {
  private readonly cache = new Map<string, { at: number; rows: CrossRow[] }>();

  constructor(private readonly db: DrizzleDb) {}

  private tenantEq(tenantId: number | null) {
    return tenantId != null ? eq(scmCrossElasticity.tenantId, tenantId) : sql`true`;
  }

  private invalidate(tenantId: number | null) { this.cache.delete(String(tenantId ?? 'null')); }

  /** Aggregate a run's per-branch menu series into one daily demand map per item. */
  private static demandByItem(series: DenseSeries[]): Map<string, Map<string, number>> {
    const out = new Map<string, Map<string, number>>();
    for (const s of series) {
      let day = out.get(s.itemId);
      if (!day) { day = new Map(); out.set(s.itemId, day); }
      for (let i = 0; i < s.values.length; i++) {
        const ds = addDaysYmd(s.startDate, i);
        day.set(ds, (day.get(ds) ?? 0) + (s.values[i] ?? 0));
      }
    }
    return out;
  }

  /** The governed daily price per item, from the extracted regressors. */
  private static priceByItem(regressors: Map<string, ScmSeriesRegressor[]>): Map<string, Map<string, number>> {
    const out = new Map<string, Map<string, number>>();
    for (const [sku, rows] of regressors) {
      const day = new Map<string, number>();
      for (const r of rows) if (r.price != null && r.price > 0) day.set(r.ds, r.price);
      if (day.size) out.set(sku, day);
    }
    return out;
  }

  /**
   * Estimate + persist category-scoped cross-elasticities from a run's extracted data. Only credible
   * γ are written (upsert); a not-identified pair leaves any prior row untouched. `catBySku` maps each
   * menu sku to its category (empty/absent ⇒ the item is not paired).
   */
  async estimateAndPersist(
    tenantId: number | null,
    series: DenseSeries[],
    regressors: Map<string, ScmSeriesRegressor[]>,
    catBySku: Map<string, string>,
  ): Promise<number> {
    const demand = ScmCrossElasticityService.demandByItem(series);
    const price = ScmCrossElasticityService.priceByItem(regressors);

    // Group the forecast skus by their (non-empty) category.
    const byCat = new Map<string, string[]>();
    for (const sku of demand.keys()) {
      const cat = (catBySku.get(sku) ?? '').trim();
      if (!cat) continue;
      const arr = byCat.get(cat) ?? [];
      arr.push(sku);
      byCat.set(cat, arr);
    }

    let written = 0;
    for (const [cat, skus] of byCat) {
      if (skus.length < 2 || skus.length > MAX_CATEGORY_ITEMS) continue;
      for (const a of skus) {
        const dA = demand.get(a);
        if (!dA) continue;
        for (const b of skus) {
          if (a === b) continue;
          const pB = price.get(b);
          if (!pB) continue;
          const { gamma, r2, nObs } = estimateCrossElasticity(dA, pB);
          if (gamma == null) continue;
          await this.upsert(tenantId, a, b, cat, gamma, r2, nObs);
          written++;
        }
      }
    }
    if (written) this.invalidate(tenantId);
    return written;
  }

  async upsert(
    tenantId: number | null, itemA: string, itemB: string, category: string | null,
    gamma: number, r2: number | null, nObs: number,
  ) {
    const existing = await this.db.select({ id: scmCrossElasticity.id }).from(scmCrossElasticity)
      .where(and(this.tenantEq(tenantId), eq(scmCrossElasticity.itemA, itemA), eq(scmCrossElasticity.itemB, itemB)))
      .limit(1);
    const vals = {
      category, gamma: String(gamma), r2: r2 != null ? String(r2) : null, nObs,
      estimatedAt: new Date(), updatedAt: new Date(),
    };
    if (existing.length) {
      await this.db.update(scmCrossElasticity).set(vals)
        .where(and(eq(scmCrossElasticity.id, existing[0]!.id), this.tenantEq(tenantId)));
    } else {
      await this.db.insert(scmCrossElasticity).values({ tenantId: tenantId ?? null, itemA, itemB, ...vals });
    }
    this.invalidate(tenantId);
  }

  async list(tenantId: number | null): Promise<CrossRow[]> {
    const key = String(tenantId ?? 'null');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
    const rows = await this.db.select().from(scmCrossElasticity).where(this.tenantEq(tenantId));
    const mapped: CrossRow[] = rows.map((r) => ({
      itemA: r.itemA, itemB: r.itemB, category: r.category ?? null,
      gamma: Number(r.gamma), r2: r.r2 != null ? Number(r.r2) : null, nObs: r.nObs,
    }));
    this.cache.set(key, { at: Date.now(), rows: mapped });
    return mapped;
  }

  /** Multiplicative cross-response of item_a to a price change on item_b: (priceMultiplier)^γ. */
  crossResponse(gamma: number, priceMultiplier: number): number {
    if (!(priceMultiplier > 0)) return 1;
    return Math.min(Math.max(Math.pow(priceMultiplier, gamma), 0.1), 5);
  }
}

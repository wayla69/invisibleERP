import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { scmPriceElasticity } from '../../database/schema';

// docs/56 Track A (A2) — persisted own-price elasticity store.
//
// The forecast engine estimates ε (a log-log demand↔price slope) with an identifiability floor and
// returns it in the forecast attribution. A planning run upserts each CREDIBLE ε here (never a
// NULL/unidentified one), keyed by (tenant, item[, branch]); the advisory scenario tool then reads it
// to apply a price response — `demand × (newPrice/refPrice)^ε` — without re-fitting. Tenant-scoped
// (RLS at the DB + explicit tenant filter here); a small per-instance cache avoids re-reading a hot
// item within a request burst. Server-derived only — ε is never taken from client input.
//
// db-only sub-service, built positionally in the ScmPlanningService ctor body (the scm-extract /
// scm-hierarchy precedent) so the facade stays under the check-service-size cap.

export interface ElasticityRow {
  itemId: string;
  branchId: number | null;
  elasticity: number;
  r2: number | null;
  nObs: number;
}

const CACHE_TTL_MS = 60_000;

export class ScmElasticityService {
  private readonly cache = new Map<string, { at: number; rows: ElasticityRow[] }>();

  constructor(private readonly db: DrizzleDb) {}

  private tenantEq(tenantId: number | null) {
    return tenantId != null ? eq(scmPriceElasticity.tenantId, tenantId) : sql`true`;
  }

  private invalidate(tenantId: number | null) {
    this.cache.delete(String(tenantId ?? 'null'));
  }

  /**
   * Upsert one credible elasticity. Callers must pass an identified ε only (the engine returns null
   * when its floor is not met — those are skipped, never written). Keyed by (tenant, item, branch)
   * with branch NULL folded to the tenant-wide row (matches the coalesce(branch_id,0) unique index).
   */
  async upsert(
    tenantId: number | null,
    itemId: string,
    branchId: number | null,
    elasticity: number,
    r2: number | null,
    nObs: number,
  ) {
    const existing = await this.db.select({ id: scmPriceElasticity.id }).from(scmPriceElasticity)
      .where(and(
        this.tenantEq(tenantId),
        eq(scmPriceElasticity.itemId, itemId),
        sql`coalesce(${scmPriceElasticity.branchId}, 0) = ${branchId ?? 0}`,
      )).limit(1);
    const vals = {
      elasticity: String(elasticity),
      r2: r2 != null ? String(r2) : null,
      nObs,
      estimatedAt: new Date(),
      updatedAt: new Date(),
    };
    if (existing.length) {
      await this.db.update(scmPriceElasticity).set(vals)
        .where(and(eq(scmPriceElasticity.id, existing[0]!.id), this.tenantEq(tenantId)));
    } else {
      await this.db.insert(scmPriceElasticity).values({
        tenantId: tenantId ?? null, itemId, branchId: branchId ?? null, ...vals,
      });
    }
    this.invalidate(tenantId);
  }

  /** All persisted elasticities for a tenant (cached briefly). */
  async list(tenantId: number | null): Promise<ElasticityRow[]> {
    const key = String(tenantId ?? 'null');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
    const rows = await this.db.select().from(scmPriceElasticity).where(this.tenantEq(tenantId));
    const mapped: ElasticityRow[] = rows.map((r) => ({
      itemId: r.itemId,
      branchId: r.branchId ?? null,
      elasticity: Number(r.elasticity),
      r2: r.r2 != null ? Number(r.r2) : null,
      nObs: r.nObs,
    }));
    this.cache.set(key, { at: Date.now(), rows: mapped });
    return mapped;
  }

  /** The elasticity for an item, preferring the branch-specific row over the tenant-wide fallback. */
  async get(tenantId: number | null, itemId: string, branchId?: number | null): Promise<ElasticityRow | null> {
    const rows = await this.list(tenantId);
    const forItem = rows.filter((r) => r.itemId === itemId);
    if (!forItem.length) return null;
    if (branchId != null) {
      const exact = forItem.find((r) => r.branchId === branchId);
      if (exact) return exact;
    }
    return forItem.find((r) => r.branchId == null) ?? forItem[0]!;
  }

  /**
   * Multiplicative demand response for a hypothetical price change: (newPrice/refPrice)^ε, clamped to
   * a sane band so an extreme scenario price cannot plant an absurd quantity. Returns 1 (no response)
   * when no credible ε is on file — the honest default.
   */
  demandResponse(eps: number | null, priceMultiplier: number): number {
    if (eps == null || !(priceMultiplier > 0)) return 1;
    const raw = Math.pow(priceMultiplier, eps);
    return Math.min(Math.max(raw, 0.1), 5);
  }
}

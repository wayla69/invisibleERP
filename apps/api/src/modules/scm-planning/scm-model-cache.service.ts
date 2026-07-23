import { Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNull } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { scmModelCache } from '../../database/schema';

// docs/59 Track D (D2) — warm-start / model registry. A small, db-only sub-service (a distinct
// responsibility from run orchestration — docs/46 §4) that reads/writes one serialized Prophet fit per
// (tenant, branch, item). The run ships a cached fit to the engine as `warm_start`; the engine reuses it
// only when its fit_hash still matches the current training window (skipping the cmdstan refit), else it
// refits and returns fresh state the run persists back here. Two independent staleness guards, both
// fail-safe toward refitting: the fit_hash (window changed) and refit_cadence_days (age).

export interface WarmFit {
  params: string; // opaque serialized prophet fit (prophet.serialize.model_to_json)
  fit_hash: string;
  fit_wape: number | null;
}

@Injectable()
export class ScmModelCacheService {
  constructor(private readonly db: DrizzleDb) {}

  // HQ/Admin sessions bypass RLS, so scope tenant + branch EXPLICITLY (never RLS+limit alone — the
  // settings()/EXP-12 pattern). branchId null = the tenant-wide (aggregated) series row.
  private scope(tenantId: number | null, branchId: number | null) {
    return and(
      tenantId != null ? eq(scmModelCache.tenantId, tenantId) : isNull(scmModelCache.tenantId),
      branchId != null ? eq(scmModelCache.branchId, branchId) : isNull(scmModelCache.branchId),
    );
  }

  /** Cached Prophet fits for these items still within the refit cadence, keyed by itemId. */
  async loadWarmStarts(
    tenantId: number | null,
    branchId: number | null,
    itemIds: string[],
    cadenceDays: number,
  ): Promise<Map<string, WarmFit>> {
    const out = new Map<string, WarmFit>();
    if (!itemIds.length) return out;
    const freshAfter = new Date(Date.now() - Math.max(1, cadenceDays) * 86_400_000);
    const rows = await this.db.select().from(scmModelCache).where(and(
      this.scope(tenantId, branchId),
      inArray(scmModelCache.itemId, itemIds),
      eq(scmModelCache.model, 'prophet'),
      gte(scmModelCache.fittedAt, freshAfter),
    ));
    for (const r of rows) {
      out.set(r.itemId, {
        params: String(r.fitParams),
        fit_hash: r.fitHash,
        fit_wape: r.fitWape != null ? Number(r.fitWape) : null,
      });
    }
    return out;
  }

  /**
   * Upsert the fit the engine (re)produced this run. Manual upsert (select-then-update/insert) because
   * the uniqueness is an EXPRESSION index (coalesce(branch_id,0)) that drizzle's onConflict can't target.
   */
  async persistFit(
    tenantId: number | null,
    branchId: number | null,
    itemId: string,
    model: string,
    fitted: { params: string; fit_hash: string; fit_wape: number | null },
    window: { from: string | null; to: string | null },
  ): Promise<void> {
    const vals = {
      fitParams: fitted.params,
      fitHash: fitted.fit_hash,
      fitWape: fitted.fit_wape != null ? String(fitted.fit_wape) : null,
      trainingFrom: window.from,
      trainingTo: window.to,
      fittedAt: new Date(),
      updatedAt: new Date(),
    };
    const [existing] = await this.db.select({ id: scmModelCache.id }).from(scmModelCache).where(and(
      this.scope(tenantId, branchId),
      eq(scmModelCache.itemId, itemId),
      eq(scmModelCache.model, model),
    )).limit(1);
    if (existing) await this.db.update(scmModelCache).set(vals).where(eq(scmModelCache.id, existing.id));
    else await this.db.insert(scmModelCache).values({ tenantId: tenantId ?? null, branchId: branchId ?? null, itemId, model, ...vals });
  }
}

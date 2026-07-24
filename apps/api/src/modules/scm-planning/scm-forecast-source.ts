import { and, desc, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import { scmDemandForecasts, scmPlanRuns } from '../../database/schema';

// docs/59 D1 — forecast source for the nightly plan's batch-retrain reuse seam. Returns the freshest
// batch-retrain sample paths per menu item (within the staleness window). Only consumes `scope='retrain'`
// forecasts (the producer), so a nightly run never reads its own or another nightly's output. HQ/Admin
// bypasses RLS, so scope the tenant + branch explicitly (settings() pattern). Freshest-per-item via
// desc(createdAt) + first-wins. A pure helper (db in) — keeps ScmRunService under the size ratchet.
export async function loadFreshMenuPaths(
  db: DrizzleDb,
  tenantId: number | null,
  branchId: number | null,
  itemIds: string[],
): Promise<Map<string, number[][]>> {
  const out = new Map<string, number[][]>();
  if (!itemIds.length) return out;
  const hrs = Math.max(1, Number(process.env.SCM_FORECAST_STALENESS_HOURS ?? 24));
  const freshAfter = new Date(Date.now() - hrs * 3_600_000);
  const rows = await db.select({
      itemId: scmDemandForecasts.itemId,
      samplePaths: scmDemandForecasts.samplePaths,
    })
    .from(scmDemandForecasts)
    .innerJoin(scmPlanRuns, eq(scmDemandForecasts.runId, scmPlanRuns.id))
    .where(and(
      tenantId != null ? eq(scmDemandForecasts.tenantId, tenantId) : isNull(scmDemandForecasts.tenantId),
      branchId != null ? eq(scmDemandForecasts.branchId, branchId) : isNull(scmDemandForecasts.branchId),
      inArray(scmDemandForecasts.itemId, itemIds),
      eq(scmDemandForecasts.level, 'menu'),
      isNotNull(scmDemandForecasts.samplePaths),
      eq(scmPlanRuns.scope, 'retrain'),
      eq(scmPlanRuns.status, 'Completed'),
      gte(scmDemandForecasts.createdAt, freshAfter),
    ))
    .orderBy(desc(scmDemandForecasts.createdAt));
  for (const r of rows) {
    if (!out.has(r.itemId) && Array.isArray(r.samplePaths)) out.set(r.itemId, r.samplePaths as number[][]);
  }
  return out;
}

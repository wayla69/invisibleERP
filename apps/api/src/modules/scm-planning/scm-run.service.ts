import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ScmForecastRequest, ScmOptimizeItem, ScmOptimizeRequest } from '@ierp/shared';
import type { DrizzleDb } from '../../database/database.module';
import {
  scmDemandForecasts, scmOrderPlanLines, scmOrderPlans, scmPlanRuns,
} from '../../database/schema';
import { ymd } from '../../database/queries';
import { addDaysYmd } from '../demand-ml/forecast-algorithms';
import { DocNumberService } from '../../common/doc-number.service';
import { StatusLogService } from '../../common/status-log.service';
import { ScmEngineClientService } from './scm-engine-client.service';
import { ScmExtractService } from './scm-extract.service';
import { ScmElasticityService } from './scm-elasticity.service';
import { explodePaths, planHelpers, ScmFallbackPlanner } from './scm-planner';
import {
  PLAN_STATUS, SYSTEM_ACTOR, type BranchPlanDraft, type ExtractedTenantData, type PlanRunResult,
  type SuggestedLine,
} from './scm-planning.types';

// docs/54 — RUN EXECUTION: extract → forecast (engine or fallback) → BoM-explode → optimize →
// persist Draft plans. Split out of ScmPlanningService (which owns settings/policies and the plan
// LIFECYCLE) so neither file becomes a god service. Built positionally in the facade's ctor body.
@Injectable()
export class ScmRunService {
  private readonly log = new Logger(ScmRunService.name);

  constructor(
    private readonly db: DrizzleDb,
    private readonly extract: ScmExtractService,
    private readonly engine: ScmEngineClientService,
    private readonly fallback: ScmFallbackPlanner,
    private readonly docNo: DocNumberService,
    private readonly statusLog: StatusLogService,
    private readonly emit: (tenantId: number | null, type: 'scm_run_completed' | 'scm_run_failed', extra: Record<string, unknown>) => void,
    private readonly elasticity: ScmElasticityService,
  ) {}

  async executePlanRun(
    tenantId: number | null,
    scope: 'nightly' | 'manual' | 'replan',
    opts: { actor: string; branchIds?: (number | null)[]; itemIds?: string[]; triggerRef?: string } = { actor: SYSTEM_ACTOR },
  ): Promise<PlanRunResult> {
    const runDate = ymd();

    if (scope === 'nightly') {
      const [existing] = await this.db.select({ id: scmPlanRuns.id, runNo: scmPlanRuns.runNo })
        .from(scmPlanRuns).where(and(
          tenantId != null ? eq(scmPlanRuns.tenantId, tenantId) : sql`true`,
          eq(scmPlanRuns.runDate, runDate),
          eq(scmPlanRuns.scope, 'nightly'),
          sql`${scmPlanRuns.status} <> 'Failed'`,
        )).limit(1);
      if (existing) {
        return {
          run_id: existing.id, run_no: existing.runNo, engine: 'fallback',
          status: 'Skipped', plans: 0, lines: 0, series: 0, skipped: true,
        };
      }
    }

    const runNo = await this.docNo.nextDaily('SCMR');
    const [run] = await this.db.insert(scmPlanRuns).values({
      tenantId: tenantId ?? null, runNo, runDate, scope,
      triggerRef: opts.triggerRef ?? null, status: 'Running', createdBy: opts.actor,
    }).returning({ id: scmPlanRuns.id });
    const runId = run!.id;

    try {
      const data = await this.extract.extractAll(tenantId, {
        branchIds: opts.branchIds, itemIds: opts.itemIds,
      });
      const useEngine = this.engine.enabled() && data.settings.engine_enabled;
      const result = useEngine
        ? await this.runWithEngine(tenantId, runId, data, opts)
        : await this.runWithFallback(tenantId, runId, data, opts);

      const plans = await this.persistPlans(tenantId, runId, data, result.drafts, opts.actor);
      await this.db.update(scmPlanRuns).set({
        status: 'Completed',
        engine: result.engine,
        engineVersion: result.engine === 'external' ? this.engine.lastVersion : null,
        branchCount: data.branchIds.length,
        itemCount: data.ingredientIds.length,
        seriesCount: data.series.length,
        horizonDays: data.settings.horizon_days,
        serviceLevel: String(data.settings.service_level),
        requestDigest: result.digest,
        metrics: {
          method: result.method,
          branch_null_share: Math.round(data.branchNullShare * 1000) / 1000,
          engine_errors: result.engineErrors,
          plans: plans.plans, lines: plans.lines,
        },
        completedAt: new Date(),
      }).where(eq(scmPlanRuns.id, runId));

      this.emit(tenantId, 'scm_run_completed', { run_id: runId, run_no: runNo, plans: plans.plans });
      return {
        run_id: runId, run_no: runNo, engine: result.engine, status: 'Completed',
        plans: plans.plans, lines: plans.lines, series: data.series.length,
      };
    } catch (e) {
      // drizzle 0.45 nests the real pg error (SQLSTATE, constraint) under .cause — walk the chain,
      // else every DB failure reads as an opaque "Failed query: …" with no reason.
      const parts: string[] = [];
      for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
        const err = cur as { message?: string; code?: string; cause?: unknown };
        parts.push(`${err.code ? `[${err.code}] ` : ''}${err.message ?? String(cur)}`);
        cur = err.cause;
      }
      const message = parts.join(' ← ');
      this.log.error(`plan run ${runNo} failed: ${message}`);
      // Best-effort bookkeeping. When the failure was a DB error the transaction is already
      // aborted, so this UPDATE cannot run (and the run row itself rolls back) — its failure must
      // never mask the original cause, which is the only thing that explains what went wrong.
      try {
        await this.db.update(scmPlanRuns).set({
          status: 'Failed', error: message.slice(0, 1000), completedAt: new Date(),
        }).where(eq(scmPlanRuns.id, runId));
        this.emit(tenantId, 'scm_run_failed', { run_id: runId, run_no: runNo, error: message.slice(0, 200) });
      } catch {
        /* transaction already aborted — the throw below carries the real reason */
      }
      throw e instanceof Error ? e : new Error(message);
    }
  }

  /** Engine path: menu forecast → per-scenario BoM explosion → perishable optimization. */
  private async runWithEngine(
    tenantId: number | null,
    runId: number,
    data: ExtractedTenantData,
    opts: { actor: string },
  ) {
    const horizon = data.settings.horizon_days;
    const drafts: BranchPlanDraft[] = [];
    const engineErrors: string[] = [];
    const digestParts: string[] = [];
    const today = ymd();
    const wanted = new Set(data.ingredientIds);

    for (const branchId of data.branchIds) {
      const branchSeries = data.series.filter((s) => s.branchId === branchId);
      if (!branchSeries.length) continue;

      // One branch at a time, chunked — bounded memory and a payload the engine will accept.
      const menuPaths = new Map<string, number[][]>();
      const closures = this.extract.futureClosures(data.settings, branchId, horizon);
      for (const chunk of this.engine.chunk(branchSeries)) {
        const req: ScmForecastRequest = {
          contract_version: this.engine.contractVersion(),
          request_id: `${runId}:${branchId ?? 'null'}:${digestParts.length}`,
          horizon_days: horizon,
          scenario_count: data.settings.sample_paths,
          quantiles: [0.1, 0.5, 0.9],
          holidays: data.holidays.map((h) => ({ ...h, lower_window: 0, upper_window: 0 })),
          closures: [...new Set([...closures, ...chunk.flatMap((s) => s.closedDays)])],
          payday_regressor: true,
          // docs/56 A1 — governed promo/price regressors (server-derived; SCM-04). scenario=false:
          // a production run is never an advisory what-if and can never be auto-conversion-barred.
          promo_regressor: true,
          price_regressor: true,
          scenario: false,
          // docs/58 C2 — reconcile the branch's menu series up to a coherent TOTAL (bottom_up: leaves
          // unchanged, the aggregate is their exact sum). Absent history/axis depth ⇒ a flat 2-level
          // forest; C3/C4 deepen it (categories, MinT). Explosion consumes the RECONCILED leaf paths.
          reconciliation: {
            method: 'bottom_up' as const,
            covariance: 'wls_struct' as const,
            reconcile_paths: true,
            nodes: [
              { node_id: 'TOTAL', parent_id: null },
              ...chunk.map((s) => ({ node_id: `L:${s.itemId}`, parent_id: 'TOTAL', series_id: s.itemId })),
            ],
          },
          series: chunk.map((s) => ({
            series_id: s.itemId,
            class_hint: 'auto' as const,
            history: s.values.map((y, i) => ({ ds: addDaysYmd(s.startDate, i), y })),
            ...(data.regressors.get(s.itemId)?.length ? { regressors: data.regressors.get(s.itemId) } : {}),
          })),
        };
        digestParts.push(createHash('sha256').update(JSON.stringify(req)).digest('hex'));
        const res = await this.engine.forecast(req);

        // C2 trust boundary: use the reconciled (coherent) leaf paths only when the returned aggregate
        // really equals their sum within tolerance; else degrade to the base forecast. A malformed
        // hierarchy makes the engine return an error + empty `reconciled`, so we fall back safely.
        const reconLeaf = new Map<string, number[][]>();
        const totalNode = res.reconciled.find((node) => node.node_id === 'TOTAL');
        for (const node of res.reconciled) {
          if (node.node_id.startsWith('L:')) reconLeaf.set(node.node_id.slice(2), node.sample_paths);
        }
        let coherent = reconLeaf.size > 0 && !!totalNode;
        if (coherent && totalNode) {
          const leafMeanSum = [...reconLeaf.values()].reduce((a, pg) => a + planHelpers.meanOfPaths(pg), 0);
          const totalMean = planHelpers.meanOfPaths(totalNode.sample_paths);
          coherent = Math.abs(leafMeanSum - totalMean) <= 1e-6 * Math.max(1, Math.abs(totalMean));
        }
        for (const r of res.results) {
          const paths = coherent ? (reconLeaf.get(r.series_id) ?? r.sample_paths) : r.sample_paths;
          menuPaths.set(r.series_id, paths);
          await this.saveForecast(tenantId, runId, branchId, r.series_id, 'menu', r, today, horizon);
        }
        for (const err of res.errors) engineErrors.push(`${err.ref}: ${err.code}`);
      }

      const ingredientPaths = explodePaths(menuPaths, data.recipes, wanted);
      if (!ingredientPaths.size) continue;

      const optimizeItems: ScmOptimizeItem[] = [];
      for (const [itemId, paths] of ingredientPaths) {
        const p = data.params.get(itemId);
        if (!p) continue;
        const pos = planHelpers.stockFor(data.stock, branchId, itemId);
        optimizeItems.push({
          item_code: itemId,
          demand_scenarios: paths,
          current_inventory: (pos?.layers ?? []).map((l) => ({
            remaining_days: Math.min(l.remaining_days, p.shelfLifeDays ?? l.remaining_days),
            qty: l.qty,
          })),
          in_transit: pos?.inTransit ?? [],
          lead_time: { mean_days: p.leadTimeMean, std_days: p.leadTimeStd },
          shelf_life_days: Math.max(1, Math.min(365, p.shelfLifeDays ?? 365)),
          review_period_days: 1,
          unit_cost: p.unitCost,
          unit_price: p.unitPrice,
          salvage_value: p.salvageValue,
          disposal_cost: p.disposalCost,
          goodwill_cost: p.goodwillCost,
          holding_cost_per_day: p.holdingCostPerDay,
          moq: p.minOrderQty,
          pack_size: p.orderMultiple > 0 ? p.orderMultiple : 1,
          fixed_order_cost: p.fixedOrderCost,
          ...(p.wasteRatePrior != null ? { waste_rate_prior: p.wasteRatePrior } : {}),
        });
      }
      if (!optimizeItems.length) continue;

      const lines: SuggestedLine[] = [];
      let fillRate: number | null = null;
      let wasteCost = 0;
      let stockoutUnits = 0;
      for (const chunk of this.engine.chunk(optimizeItems)) {
        const req: ScmOptimizeRequest = {
          contract_version: this.engine.contractVersion(),
          request_id: `${runId}:opt:${branchId ?? 'null'}:${digestParts.length}`,
          start_ds: today,
          horizon_days: horizon,
          items: chunk,
          time_budget_ms: 20_000,
        };
        digestParts.push(createHash('sha256').update(JSON.stringify(req)).digest('hex'));
        const res = await this.engine.optimize(req);
        for (const err of res.errors) engineErrors.push(`${err.ref}: ${err.code}`);
        const fills: number[] = [];
        for (const plan of res.plans) {
          const p = data.params.get(plan.item_code);
          if (!p) continue;
          // Only today's order is actionable; later orders are shown as the projected schedule.
          const todayQty = plan.orders
            .filter((o) => o.order_ds === today)
            .reduce((a, b) => a + b.qty, 0);
          fills.push(plan.expected.fill_rate);
          wasteCost += plan.expected.waste_cost;
          stockoutUnits += plan.expected.lost_sales_units;
          if (todayQty <= 0) continue;
          // Trust boundary: clamp before persisting so a buggy engine cannot plant an absurd qty.
          const { qty, clamped } = planHelpers.clampQty(todayQty, p);
          if (qty <= 0) continue;
          const pos = planHelpers.stockFor(data.stock, branchId, plan.item_code);
          const expiring = (pos?.layers ?? [])
            .filter((l) => l.remaining_days <= Math.ceil(p.leadTimeMean) + 1)
            .reduce((a, b) => a + b.qty, 0);
          lines.push({
            itemId: plan.item_code, qty, reason: 'optimize',
            unitCost: p.unitCost, vendorId: p.vendorId,
            onHand: pos?.onHand ?? 0, expiring,
            inTransit: (pos?.inTransit ?? []).reduce((a, b) => a + b.qty, 0),
            coverageDays: null,
            stockoutRiskPct: Math.round((1 - plan.expected.fill_rate) * 100_000) / 1000,
            detail: {
              method: plan.method,
              solver: plan.solver,
              schedule: plan.orders,
              order_up_to: plan.order_up_to.slice(0, 7),
              safety_stock: plan.safety_stock.slice(0, 7),
              expected: plan.expected,
              clamped: clamped || undefined,
            },
          });
        }
        if (fills.length) {
          const avg = fills.reduce((a, b) => a + b, 0) / fills.length;
          fillRate = fillRate == null ? avg : (fillRate + avg) / 2;
        }
      }
      if (lines.length) {
        drafts.push({
          branchId, lines,
          expected: {
            fill_rate: fillRate,
            waste_cost: Math.round(wasteCost * 100) / 100,
            stockout_cost: Math.round(stockoutUnits * 100) / 100,
          },
        });
      }
    }

    return {
      drafts, engine: 'external' as const, method: 'engine',
      engineErrors, digest: createHash('sha256').update(digestParts.join('|')).digest('hex'),
    };
  }

  /** No-engine path — see ScmFallbackPlanner for why it rescales rather than trusting demand-ml's level. */
  private async runWithFallback(
    tenantId: number | null,
    runId: number,
    data: ExtractedTenantData,
    _opts: { actor: string },
  ) {
    const res = await this.fallback.plan(tenantId, data, data.branchIds);
    const today = ymd();
    for (const [key, values] of res.forecasts) {
      const [branchRaw, itemId] = key.split('|');
      await this.db.insert(scmDemandForecasts).values({
        tenantId: tenantId ?? null, runId,
        branchId: branchRaw ? Number(branchRaw) : null,
        itemId: itemId!, level: 'ingredient', method: res.method,
        horizon: values.length, startDate: addDaysYmd(today, 1),
        mean: values, p10: null, p50: null, p90: null,
      });
    }
    return {
      drafts: res.drafts, engine: 'fallback' as const, method: res.method,
      engineErrors: [] as string[],
      digest: createHash('sha256').update(`fallback:${runId}:${data.series.length}`).digest('hex'),
    };
  }

  private async saveForecast(
    tenantId: number | null, runId: number, branchId: number | null, itemId: string,
    level: 'menu' | 'ingredient',
    r: {
      model: string; points: { q: Record<string, number> }[]; accuracy: { wape: number | null };
      attribution?: {
        promo_uplift_pct: number | null; price_elasticity: number | null;
        elasticity_r2?: number | null; elasticity_n_obs?: number | null;
        regressors_used: string[];
      } | null;
    },
    today: string, horizon: number,
  ) {
    // docs/56 A1 — persist attribution so the plan can surface promo reasons and a reviewer can tie
    // a moved quantity back to a governed input (SCM-04).
    const a = r.attribution ?? null;
    await this.db.insert(scmDemandForecasts).values({
      tenantId: tenantId ?? null, runId, branchId, itemId, level, method: r.model,
      horizon, startDate: addDaysYmd(today, 1),
      mean: r.points.map((p) => (p as { yhat?: number }).yhat ?? 0),
      p10: r.points.map((p) => p.q['0.1'] ?? null),
      p50: r.points.map((p) => p.q['0.5'] ?? null),
      p90: r.points.map((p) => p.q['0.9'] ?? null),
      wape: r.accuracy.wape != null ? String(r.accuracy.wape) : null,
      promoUpliftPct: a?.promo_uplift_pct != null ? String(a.promo_uplift_pct) : null,
      priceElasticity: a?.price_elasticity != null ? String(a.price_elasticity) : null,
      regressorsUsed: a?.regressors_used ?? [],
    });
    // docs/56 A2 — persist a CREDIBLE menu-level elasticity so the advisory scenario tool can apply a
    // price response without re-fitting. The engine returns null when its identifiability floor is not
    // met, so only identified estimates land (server-derived; never client input).
    if (level === 'menu' && a?.price_elasticity != null) {
      await this.elasticity.upsert(
        tenantId, itemId, branchId, a.price_elasticity,
        a.elasticity_r2 ?? null, a.elasticity_n_obs ?? 0,
      );
    }
  }

  /** Persist one Draft plan per branch that has at least one suggested line. */
  private async persistPlans(
    tenantId: number | null,
    runId: number,
    data: ExtractedTenantData,
    drafts: BranchPlanDraft[],
    actor: string,
  ) {
    let plans = 0;
    let lines = 0;
    for (const draft of drafts) {
      if (!draft.lines.length) continue;
      const planNo = await this.docNo.nextDaily('SCMP');
      const estTotal = draft.lines.reduce((a, l) => a + l.qty * l.unitCost, 0);
      const [plan] = await this.db.insert(scmOrderPlans).values({
        tenantId: tenantId ?? null, planNo, runId, branchId: draft.branchId,
        status: PLAN_STATUS.draft,
        horizonDays: data.settings.horizon_days,
        serviceLevel: String(data.settings.service_level),
        estTotalCost: String(Math.round(estTotal * 100) / 100),
        expectedWasteCost: draft.expected.waste_cost != null ? String(draft.expected.waste_cost) : null,
        expectedStockoutCost: draft.expected.stockout_cost != null ? String(draft.expected.stockout_cost) : null,
        expectedFillRate: draft.expected.fill_rate != null ? String(draft.expected.fill_rate) : null,
        engine: this.engine.enabled() ? 'external' : 'fallback',
        createdBy: actor,
      }).returning({ id: scmOrderPlans.id });

      for (const l of draft.lines) {
        const p = data.params.get(l.itemId);
        await this.db.insert(scmOrderPlanLines).values({
          tenantId: tenantId ?? null, planId: plan!.id, itemId: l.itemId,
          itemDescription: p?.description ?? null, uom: p?.uom ?? null,
          suggestedQty: String(l.qty), finalQty: String(l.qty),
          unitCostEst: String(l.unitCost), vendorId: l.vendorId,
          onHandQty: String(l.onHand), expiringQty: String(l.expiring),
          inTransitQty: String(l.inTransit),
          coverageDays: l.coverageDays != null ? String(Math.round(l.coverageDays * 100) / 100) : null,
          stockoutRiskPct: l.stockoutRiskPct != null ? String(l.stockoutRiskPct) : null,
          reason: l.reason, detail: l.detail,
        });
        lines++;
      }
      await this.statusLog.log('SCMP', planNo, '', PLAN_STATUS.draft, actor);
      plans++;
    }
    return { plans, lines };
  }

  async pruneOldRuns(tenantId: number | null, retentionDays: number) {
    const cutoff = addDaysYmd(ymd(), -Math.max(7, retentionDays));
    const old = await this.db.select({ id: scmPlanRuns.id }).from(scmPlanRuns).where(and(
      tenantId != null ? eq(scmPlanRuns.tenantId, tenantId) : sql`true`,
      sql`${scmPlanRuns.runDate} < ${cutoff}`,
    )).limit(200);
    if (!old.length) return { pruned: 0 };
    const ids = old.map((r) => r.id);
    await this.db.delete(scmDemandForecasts).where(inArray(scmDemandForecasts.runId, ids));
    // Plans that never went anywhere are noise; converted/approved ones are the audit trail.
    const stale = await this.db.select({ id: scmOrderPlans.id }).from(scmOrderPlans).where(and(
      inArray(scmOrderPlans.runId, ids), eq(scmOrderPlans.status, PLAN_STATUS.draft),
    ));
    if (stale.length) {
      const staleIds = stale.map((p) => p.id);
      await this.db.delete(scmOrderPlanLines).where(inArray(scmOrderPlanLines.planId, staleIds));
      await this.db.delete(scmOrderPlans).where(inArray(scmOrderPlans.id, staleIds));
    }
    return { pruned: ids.length };
  }
}

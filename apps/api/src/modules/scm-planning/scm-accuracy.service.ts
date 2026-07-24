import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { scmAccuracyHistory, scmDemandForecasts, scmSettings } from '../../database/schema';
import { ymd } from '../../database/queries';
import { addDaysYmd } from '../demand-ml/forecast-algorithms';
import { captureOpsAlert } from '../../observability/instrumentation';
import { ScmExtractService } from './scm-extract.service';
import { ScmLiveService } from './scm-live.service';

// docs/59 Track D (D4) — forecast-accuracy monitoring (control SCM-07).
//
// Detective complement to SCM-03's preventive order sizing: a run already persists each series' backtest
// WAPE (the fit-time baseline); D4 computes the REALIZED WAPE/bias by comparing a prior forecast to the
// actuals that have since arrived, records it in `scm_accuracy_history`, and flags a series `degraded`
// when its realized WAPE exceeds the baseline by `degradation_factor` for `sustained_periods` consecutive
// as-of dates (one bad day is not an alert). A transition into degraded raises a `captureOpsAlert` +
// publishes `scm_accuracy_degraded` on the SSE bus, and the flag force-refits the series on the next batch
// (D2 refit trigger). Actuals come through the extract's PUBLIC surface — no new query path.

const DEFAULT_FACTOR = 1.5;
const DEFAULT_SUSTAINED = 3;

interface AccuracyConfig { factor: number; sustained: number }

@Injectable()
export class ScmAccuracyService {
  private readonly log = new Logger(ScmAccuracyService.name);
  private readonly extract: ScmExtractService;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly live: ScmLiveService,
  ) {
    this.extract = new ScmExtractService(db);
  }

  private tenantEq(tenantId: number | null) {
    return tenantId != null ? eq(scmAccuracyHistory.tenantId, tenantId) : isNull(scmAccuracyHistory.tenantId);
  }

  private async config(tenantId: number | null): Promise<AccuracyConfig> {
    const [row] = await this.db.select({
        factor: scmSettings.accuracyDegradationFactor,
        sustained: scmSettings.accuracySustainedPeriods,
      }).from(scmSettings)
      .where(tenantId != null ? eq(scmSettings.tenantId, tenantId) : isNull(scmSettings.tenantId)).limit(1);
    const envFactor = Number(process.env.SCM_ACCURACY_DEGRADATION_FACTOR);
    const envSustained = Number(process.env.SCM_ACCURACY_SUSTAINED_PERIODS);
    const factor = Number(row?.factor) || (Number.isFinite(envFactor) && envFactor > 0 ? envFactor : DEFAULT_FACTOR);
    const sustained = Number(row?.sustained) || (Number.isFinite(envSustained) && envSustained > 0 ? envSustained : DEFAULT_SUSTAINED);
    return { factor: Math.max(1, factor), sustained: Math.max(1, Math.round(sustained)) };
  }

  /**
   * Reconcile realized accuracy for every menu series whose forecast horizon has fully elapsed by `asOf`
   * (freshest forecast per (branch, item)), writing one `scm_accuracy_history` row each. A series whose
   * realized WAPE has exceeded its baseline for `sustained_periods` consecutive as-of dates is flagged
   * degraded; the transition into degraded fires the ops alert + SSE event (control SCM-07).
   */
  async refreshAccuracy(tenantId: number | null, opts: { asOf?: string } = {}): Promise<{ scored: number; degraded: number; as_of: string }> {
    const asOf = opts.asOf ?? ymd();
    const cfg = await this.config(tenantId);

    const rows = await this.db.select().from(scmDemandForecasts)
      .where(and(
        tenantId != null ? eq(scmDemandForecasts.tenantId, tenantId) : isNull(scmDemandForecasts.tenantId),
        eq(scmDemandForecasts.level, 'menu'),
      ))
      .orderBy(desc(scmDemandForecasts.createdAt)).limit(3000);
    // freshest forecast per (branch, item) whose FULL horizon has elapsed by asOf
    const seen = new Set<string>();
    const targets = rows.filter((r) => {
      if (addDaysYmd(String(r.startDate), r.horizon) > asOf) return false;
      const key = `${r.branchId ?? ''}:${r.itemId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!targets.length) return { scored: 0, degraded: 0, as_of: asOf };

    // Actuals via the extract's PUBLIC menu-demand surface (loose coupling — no new query path).
    const data = await this.extract.extractAll(tenantId, {});
    const actual = new Map<string, Map<string, number>>();
    for (const s of data.series) {
      const m = new Map<string, number>();
      s.values.forEach((v, i) => m.set(addDaysYmd(s.startDate, i), v));
      actual.set(`${s.branchId ?? ''}:${s.itemId}`, m);
    }

    let degradedCount = 0;
    for (const r of targets) {
      const key = `${r.branchId ?? ''}:${r.itemId}`;
      const mean = (r.mean as number[]) ?? [];
      const am = actual.get(key);
      let sumAbs = 0, sumActual = 0, sumSigned = 0, n = 0;
      for (let i = 0; i < r.horizon; i++) {
        const a = am?.get(addDaysYmd(String(r.startDate), i));
        if (a == null) continue;
        const f = Number(mean[i] ?? 0);
        sumAbs += Math.abs(a - f); sumActual += a; sumSigned += f - a; n++;
      }
      const realizedWape = sumActual > 0 ? sumAbs / sumActual : null;
      const bias = sumActual > 0 ? sumSigned / sumActual : null;
      const fitWape = r.wape != null ? Number(r.wape) : null;
      const over = realizedWape != null && fitWape != null && realizedWape > fitWape * cfg.factor;
      const priorStreak = await this.trailingOverStreak(tenantId, r.branchId ?? null, r.itemId, asOf, cfg.factor);
      const degraded = over && priorStreak + 1 >= cfg.sustained;
      const wasDegraded = await this.latestDegraded(tenantId, r.branchId ?? null, r.itemId, asOf);

      await this.db.insert(scmAccuracyHistory).values({
        tenantId, branchId: r.branchId ?? null, itemId: r.itemId, asOfDate: asOf,
        wape: realizedWape != null ? String(round4(realizedWape)) : null,
        bias: bias != null ? String(round4(bias)) : null,
        fitWape: fitWape != null ? String(round4(fitWape)) : null,
        model: r.method, sampleN: n, degraded, runId: r.runId,
      });

      if (degraded) {
        degradedCount++;
        if (!wasDegraded) {
          // Only the TRANSITION into degraded alerts (a sustained-drift onset), not every subsequent day.
          captureOpsAlert('scm_forecast_degraded', {
            tenant_id: tenantId, branch_id: r.branchId ?? null, item_id: r.itemId,
            realized_wape: realizedWape, fit_wape: fitWape, factor: cfg.factor, sustained_periods: cfg.sustained,
            degraded: 'forecast accuracy has degraded past its baseline for the sustained window — the series will be force-refit on the next batch (SCM-07)',
          });
          const extra: Record<string, unknown> = { branch_id: r.branchId ?? null, item_id: r.itemId, wape: realizedWape, fit_wape: fitWape };
          try { this.live.publish({ type: 'scm_accuracy_degraded', tenant_id: tenantId, ...extra }); } catch { /* bus optional */ }
        }
      }
    }
    return { scored: targets.length, degraded: degradedCount, as_of: asOf };
  }

  /** Consecutive prior as-of rows (before `asOf`, most-recent-first) whose realized WAPE was over the
   *  baseline × factor — stops at the first non-over row (the "sustained" streak preceding today). */
  private async trailingOverStreak(tenantId: number | null, branchId: number | null, itemId: string, asOf: string, factor: number): Promise<number> {
    const rows = await this.db.select({ wape: scmAccuracyHistory.wape, fitWape: scmAccuracyHistory.fitWape })
      .from(scmAccuracyHistory)
      .where(and(this.tenantEq(tenantId), this.branchEq(branchId), eq(scmAccuracyHistory.itemId, itemId), lt(scmAccuracyHistory.asOfDate, asOf)))
      .orderBy(desc(scmAccuracyHistory.asOfDate)).limit(50);
    let streak = 0;
    for (const r of rows) {
      const w = r.wape != null ? Number(r.wape) : null;
      const f = r.fitWape != null ? Number(r.fitWape) : null;
      if (w != null && f != null && w > f * factor) streak++;
      else break;
    }
    return streak;
  }

  private async latestDegraded(tenantId: number | null, branchId: number | null, itemId: string, beforeAsOf: string): Promise<boolean> {
    const [row] = await this.db.select({ degraded: scmAccuracyHistory.degraded })
      .from(scmAccuracyHistory)
      .where(and(this.tenantEq(tenantId), this.branchEq(branchId), eq(scmAccuracyHistory.itemId, itemId), lt(scmAccuracyHistory.asOfDate, beforeAsOf)))
      .orderBy(desc(scmAccuracyHistory.asOfDate)).limit(1);
    return !!row?.degraded;
  }

  private branchEq(branchId: number | null) {
    return branchId != null ? eq(scmAccuracyHistory.branchId, branchId) : isNull(scmAccuracyHistory.branchId);
  }

  /** docs/59 D4 — the D2 refit trigger: (branch, item) keys whose LATEST accuracy row is degraded, so the
   *  next batch force-refits them (drops their warm-start). Returns a Set of itemIds for the given branch. */
  async degradedItems(tenantId: number | null, branchId: number | null, itemIds: string[]): Promise<Set<string>> {
    if (!itemIds.length) return new Set();
    const rows = await this.db.select({
        itemId: scmAccuracyHistory.itemId, asOf: scmAccuracyHistory.asOfDate, degraded: scmAccuracyHistory.degraded,
      }).from(scmAccuracyHistory)
      .where(and(this.tenantEq(tenantId), this.branchEq(branchId)))
      .orderBy(desc(scmAccuracyHistory.asOfDate));
    const out = new Set<string>();
    const seen = new Set<string>();
    const want = new Set(itemIds);
    for (const r of rows) {
      if (!want.has(r.itemId) || seen.has(r.itemId)) continue;
      seen.add(r.itemId);            // latest row per item wins
      if (r.degraded) out.add(r.itemId);
    }
    return out;
  }

  /** Read-only digest for the `scm_forecast_accuracy` BI report: latest WAPE/bias per (branch, item),
   *  currently-degraded items, and the tenant's average realized WAPE trend. */
  async digest(tenantId: number | null): Promise<{ items: unknown[]; degraded: number; avg_wape: number | null }> {
    const rows = await this.db.select().from(scmAccuracyHistory)
      .where(this.tenantEq(tenantId))
      .orderBy(desc(scmAccuracyHistory.asOfDate)).limit(2000);
    const latest = new Map<string, typeof rows[number]>();
    for (const r of rows) {
      const key = `${r.branchId ?? ''}:${r.itemId}`;
      if (!latest.has(key)) latest.set(key, r);
    }
    const items = [...latest.values()].map((r) => ({
      branch_id: r.branchId, item_id: r.itemId, as_of: r.asOfDate,
      wape: r.wape != null ? Number(r.wape) : null, bias: r.bias != null ? Number(r.bias) : null,
      fit_wape: r.fitWape != null ? Number(r.fitWape) : null, model: r.model, degraded: r.degraded,
    }));
    const withWape = items.filter((i) => i.wape != null);
    const avg = withWape.length ? withWape.reduce((a, i) => a + (i.wape ?? 0), 0) / withWape.length : null;
    return {
      items: items.sort((a, b) => Number(b.degraded) - Number(a.degraded) || (b.wape ?? 0) - (a.wape ?? 0)),
      degraded: items.filter((i) => i.degraded).length,
      avg_wape: avg != null ? round4(avg) : null,
    };
  }
}

function round4(v: number): number { return Math.round(v * 1e4) / 1e4; }

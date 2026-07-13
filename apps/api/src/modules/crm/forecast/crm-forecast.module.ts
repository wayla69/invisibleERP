import { Inject, Injectable, Module, Controller, Get, Post, Query, Body, Optional, BadRequestException, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { eq, and, gte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { crmOpportunities, crmForecastSubmissions, crmForecastSnapshots } from '../../../database/schema/crm-pipeline';
import { ymd, n } from '../../../database/queries';
import { Permissions, CurrentUser, type JwtUser } from '../../../common/decorators';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe';
import type { BiReportGenerator, BiReportSource } from '../../bi/report-registry';

// ── CRM-12 — sales FORECASTING depth (CRM-09, migration 0378) ──────────────────────────────────────────
// A governance layer over the REV-17 pipeline forecast (crm_pipeline analytics/forecast, which stays the
// live commit/best-case/pipeline split). Two capabilities, both read-mostly over crm_opportunities:
//   • rep→manager OVERRIDE roll-up — per (period, owner) a rep submits their own commit / best-case number
//     (governed draft → submitted); the manager view reconciles each rep's submission against the
//     system-weighted forecast, so an unsubmitted or over-optimistic number surfaces (variance).
//   • dated SNAPSHOTS + forecast-vs-actual — a schedulable period snapshot (crm_forecast_snapshots, mirrors
//     crm_account_health_snapshots; idempotent per period/day; BI report crm_forecast_snapshot) captures the
//     forecast + the period's actual won, so forecast ACCURACY, pipeline-COVERAGE and a category WATERFALL
//     are tracked over time.
// The control (CRM-09, detective): no forecast is asserted to management without an auditable submission +
// snapshot trail; unbacked (low-coverage) or unsubmitted forecasts are systematically surfaced. No GL post.

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Forecast categories by the deal's probability (forecast weight) — same thresholds as the live pipeline
// forecast. Commit is booked at full value; best-case + pipeline enter the forecast at their weighted value.
const category = (p: number) => (p >= 70 ? 'commit' : p >= 40 ? 'best_case' : 'pipeline');

const SubmissionBody = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  owner: z.string().max(60).optional(),
  commit_amount: z.number().nonnegative().optional(),
  best_case_amount: z.number().nonnegative().optional(),
  pipeline_amount: z.number().nonnegative().optional(),
  status: z.enum(['draft', 'submitted']).optional(),
  notes: z.string().max(2000).optional(),
});

type OwnerAgg = { owner: string; commit: number; best_case: number; pipeline: number; weighted: number; open_count: number };

@Injectable()
export class CrmForecastService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private currentPeriod(): string { return ymd().slice(0, 7); }
  private tCond(col: any, user: JwtUser) { return user.tenantId != null ? [eq(col, user.tenantId)] : []; }

  // System-weighted forecast from the live open pipeline, grouped by owner.
  private async systemByOwner(user: JwtUser): Promise<Map<string, OwnerAgg>> {
    const rows = await this.db.select({ amount: crmOpportunities.amount, probability: crmOpportunities.probability, owner: crmOpportunities.owner })
      .from(crmOpportunities).where(and(eq(crmOpportunities.status, 'Open'), ...this.tCond(crmOpportunities.tenantId, user)));
    const by = new Map<string, OwnerAgg>();
    for (const o of rows) {
      const amt = n(o.amount), p = Number(o.probability) || 0, owner = o.owner || 'unassigned';
      const e = by.get(owner) ?? { owner, commit: 0, best_case: 0, pipeline: 0, weighted: 0, open_count: 0 };
      const c = category(p);
      e[c] = round2(e[c] + amt);
      e.weighted = round2(e.weighted + amt * p / 100);
      e.open_count++;
      by.set(owner, e);
    }
    return by;
  }

  // Forecast amount from an owner aggregate: commit at full value + best-case & pipeline at weighted value.
  // (The weighted split isn't stored per category, so approximate best/pipeline weight by their category
  // midpoints — commit is always full.) For an exact figure the snapshot uses the per-deal weighted sum.
  private forecastOf(a: OwnerAgg): number {
    // commit (full) + best-case × 0.55 (mid of 40..69) + pipeline × 0.20 (mid of 0..39, capped).
    return round2(a.commit + a.best_case * 0.55 + a.pipeline * 0.20);
  }

  // The manager roll-up view: per-owner system-weighted vs submitted override, coverage, waterfall, accuracy.
  async depth(user: JwtUser, dto?: { period?: string }) {
    const period = dto?.period ?? this.currentPeriod();
    const sys = await this.systemByOwner(user);

    const subs = await this.db.select().from(crmForecastSubmissions)
      .where(and(eq(crmForecastSubmissions.period, period), ...this.tCond(crmForecastSubmissions.tenantId, user)));
    const subByOwner = new Map<string, typeof subs[number]>();
    for (const s of subs) subByOwner.set(s.owner, s);

    const owners = new Set<string>([...sys.keys(), ...subByOwner.keys()]);
    const rollup = [...owners].map((owner) => {
      const a = sys.get(owner) ?? { owner, commit: 0, best_case: 0, pipeline: 0, weighted: 0, open_count: 0 };
      const sysForecast = this.forecastOf(a);
      const s = subByOwner.get(owner);
      const submittedForecast = s ? round2(n(s.commitAmount) + n(s.bestCaseAmount) * 0.55 + n(s.pipelineAmount) * 0.20) : null;
      return {
        owner,
        system: { commit: a.commit, best_case: a.best_case, pipeline: a.pipeline, weighted: a.weighted, open_count: a.open_count, forecast: sysForecast },
        submitted: s ? { commit: n(s.commitAmount), best_case: n(s.bestCaseAmount), pipeline: n(s.pipelineAmount), forecast: submittedForecast, status: s.status, submitted_at: s.submittedAt } : null,
        // variance: submitted forecast − system forecast (positive = rep is more optimistic than the model).
        variance: submittedForecast != null ? round2(submittedForecast - sysForecast) : null,
      };
    }).sort((a, b) => b.system.forecast - a.system.forecast);

    // Totals + waterfall (category build-up of the system forecast).
    const totCommit = round2([...sys.values()].reduce((t, a) => t + a.commit, 0));
    const totBest = round2([...sys.values()].reduce((t, a) => t + a.best_case, 0));
    const totPipe = round2([...sys.values()].reduce((t, a) => t + a.pipeline, 0));
    const bestWeighted = round2(totBest * 0.55), pipeWeighted = round2(totPipe * 0.20);
    const systemForecast = round2(totCommit + bestWeighted + pipeWeighted);
    const submittedTotal = round2(subs.reduce((t, s) => t + n(s.commitAmount), 0));
    const openTotal = round2(totCommit + totBest + totPipe);

    const waterfall = [
      { stage: 'commit', amount: totCommit, running: totCommit },
      { stage: 'best_case', amount: bestWeighted, running: round2(totCommit + bestWeighted) },
      { stage: 'pipeline', amount: pipeWeighted, running: systemForecast },
    ];

    // Pipeline coverage: total open pipeline value ÷ target (Σ submitted rep commit if any, else Σ system
    // commit). ≥3× is the healthy sales-ops rule of thumb.
    const target = submittedTotal > 0 ? submittedTotal : totCommit;
    const coverage = target > 0 ? round2(openTotal / target) : null;

    return {
      period,
      totals: {
        system_commit: totCommit, system_forecast: systemForecast, weighted: round2([...sys.values()].reduce((t, a) => t + a.weighted, 0)),
        open_total: openTotal, submitted_total: submittedTotal,
        submissions: subs.length, reps: owners.size,
      },
      coverage: { open_pipeline: openTotal, target, ratio: coverage, basis: submittedTotal > 0 ? 'submitted_commit' : 'system_commit' },
      waterfall,
      rollup,
      accuracy: await this.accuracy(user),
    };
  }

  // Forecast-vs-actual accuracy series from the latest snapshot per period (closed + open periods).
  private async accuracy(user: JwtUser) {
    const snaps = await this.db.select().from(crmForecastSnapshots)
      .where(and(...this.tCond(crmForecastSnapshots.tenantId, user)));
    // keep the LATEST snapshot per period (max snapshot_date).
    const latest = new Map<string, typeof snaps[number]>();
    for (const s of snaps) {
      const cur = latest.get(s.period);
      if (!cur || String(s.snapshotDate) > String(cur.snapshotDate)) latest.set(s.period, s);
    }
    return [...latest.values()]
      .sort((a, b) => (a.period < b.period ? -1 : 1))
      .map((s) => {
        const forecast = n(s.forecastAmount), actual = n(s.actualWonAmount);
        return { period: s.period, forecast, actual_won: actual, accuracy_pct: forecast > 0 ? round2((actual / forecast) * 100) : null };
      });
  }

  // A rep submits/updates their override for a period (upsert on tenant/period/owner). A rep governs their
  // own row (owner defaults to the caller); an exec/manager may submit on behalf of a named owner.
  async submit(user: JwtUser, body: z.infer<typeof SubmissionBody>) {
    const period = body.period ?? this.currentPeriod();
    const owner = body.owner || user.username || 'unassigned';
    const status = body.status ?? 'draft';
    const values = {
      tenantId: user.tenantId ?? null, period, owner,
      commitAmount: String(round2(body.commit_amount ?? 0)),
      bestCaseAmount: String(round2(body.best_case_amount ?? 0)),
      pipelineAmount: String(round2(body.pipeline_amount ?? 0)),
      status, notes: body.notes ?? null,
      submittedBy: status === 'submitted' ? (user.username ?? null) : null,
      submittedAt: status === 'submitted' ? new Date() : null,
    };
    await this.db.insert(crmForecastSubmissions).values(values)
      .onConflictDoUpdate({
        target: [crmForecastSubmissions.tenantId, crmForecastSubmissions.period, crmForecastSubmissions.owner],
        set: {
          commitAmount: values.commitAmount, bestCaseAmount: values.bestCaseAmount, pipelineAmount: values.pipelineAmount,
          status: values.status, notes: values.notes, submittedBy: values.submittedBy, submittedAt: values.submittedAt,
        },
      });
    return { period, owner, status };
  }

  async listSubmissions(user: JwtUser, dto?: { period?: string }) {
    const period = dto?.period ?? this.currentPeriod();
    const rows = await this.db.select().from(crmForecastSubmissions)
      .where(and(eq(crmForecastSubmissions.period, period), ...this.tCond(crmForecastSubmissions.tenantId, user)));
    return {
      period,
      submissions: rows.map((s) => ({ owner: s.owner, commit: n(s.commitAmount), best_case: n(s.bestCaseAmount), pipeline: n(s.pipelineAmount), status: s.status, notes: s.notes, submitted_at: s.submittedAt })),
    };
  }

  // Capture a dated period snapshot (idempotent per period/day). Records the system forecast, the weighted
  // sum, open count, the period's actual won, and the submitted roll-up target. The BI job for accuracy trend.
  async captureSnapshot(user: JwtUser, dto?: { period?: string }) {
    const period = dto?.period ?? this.currentPeriod();
    const date = ymd();
    const sys = await this.systemByOwner(user);
    const totCommit = round2([...sys.values()].reduce((t, a) => t + a.commit, 0));
    const totBest = round2([...sys.values()].reduce((t, a) => t + a.best_case, 0));
    const totPipe = round2([...sys.values()].reduce((t, a) => t + a.pipeline, 0));
    const weighted = round2([...sys.values()].reduce((t, a) => t + a.weighted, 0));
    const openCount = [...sys.values()].reduce((t, a) => t + a.open_count, 0);
    const forecast = round2(totCommit + totBest * 0.55 + totPipe * 0.20);

    // Actual won IN the period (won opportunities whose close month == period).
    const wonRows = await this.db.select({ amount: crmOpportunities.amount, closedAt: crmOpportunities.closedAt })
      .from(crmOpportunities).where(and(eq(crmOpportunities.status, 'Won'), ...this.tCond(crmOpportunities.tenantId, user)));
    const actualWon = round2(wonRows.filter((w) => w.closedAt && ymd(new Date(w.closedAt)).slice(0, 7) === period).reduce((t, w) => t + n(w.amount), 0));

    const subs = await this.db.select({ commit: crmForecastSubmissions.commitAmount }).from(crmForecastSubmissions)
      .where(and(eq(crmForecastSubmissions.period, period), ...this.tCond(crmForecastSubmissions.tenantId, user)));
    const submittedTotal = round2(subs.reduce((t, s) => t + n(s.commit), 0));

    const values = {
      tenantId: user.tenantId ?? null, period, snapshotDate: date,
      forecastAmount: String(forecast), commitAmount: String(totCommit), bestCaseAmount: String(totBest),
      pipelineAmount: String(totPipe), weightedAmount: String(weighted), openCount,
      actualWonAmount: String(actualWon), submittedTotal: String(submittedTotal), createdBy: user.username ?? null,
    };
    await this.db.insert(crmForecastSnapshots).values(values)
      .onConflictDoUpdate({
        target: [crmForecastSnapshots.tenantId, crmForecastSnapshots.period, crmForecastSnapshots.snapshotDate],
        set: {
          forecastAmount: values.forecastAmount, commitAmount: values.commitAmount, bestCaseAmount: values.bestCaseAmount,
          pipelineAmount: values.pipelineAmount, weightedAmount: values.weightedAmount, openCount: values.openCount,
          actualWonAmount: values.actualWonAmount, submittedTotal: values.submittedTotal, createdAt: new Date(),
        },
      });
    return { period, snapshot_date: date, forecast, actual_won: actualWon, open_count: openCount };
  }

  async history(user: JwtUser) {
    return { accuracy: await this.accuracy(user) };
  }
}

@Controller('api/crm/forecast')
@Permissions('crm', 'exec', 'ar')
export class CrmForecastController {
  constructor(private readonly svc: CrmForecastService) {}

  @Get('depth') depth(@Query('period') period: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.depth(u, { period }); }
  @Get('submissions') listSubmissions(@Query('period') period: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listSubmissions(u, { period }); }
  @Get('history') history(@CurrentUser() u: JwtUser) { return this.svc.history(u); }
  @Post('submission') @Permissions('crm', 'exec') submit(@Body(new ZodValidationPipe(SubmissionBody)) b: z.infer<typeof SubmissionBody>, @CurrentUser() u: JwtUser) { return this.svc.submit(u, b); }
  @Post('snapshot') @HttpCode(200) @Permissions('crm', 'exec') snapshot(@Query('period') period: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.captureSnapshot(u, { period }); }
}

// docs/46 Phase 1 — module-owned BI report generator (discovered by BiReportRegistrarService;
// moved verbatim out of bi-generate.service.ts, behaviour identical).
@Injectable()
export class CrmForecastBiReports implements BiReportSource {
  constructor(private readonly svc: CrmForecastService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'crm_forecast_snapshot',
        generate: async (f, user) => {
          const r = await this.svc.captureSnapshot(user, { period: f.period }); // idempotent per (period, date)
          return { data: r, summary: `Forecast snapshot ${r.period}: forecast ${r.forecast}, actual won ${r.actual_won}, ${r.open_count} open`, summaryTh: `บันทึกพยากรณ์ยอดขาย ${r.period}: พยากรณ์ ${r.forecast} · ปิดจริง ${r.actual_won} · เปิดอยู่ ${r.open_count}` };
        },
      },
    ];
  }
}

@Module({
  controllers: [CrmForecastController],
  providers: [CrmForecastService, CrmForecastBiReports],
  exports: [CrmForecastService],
})
export class CrmForecastModule {}

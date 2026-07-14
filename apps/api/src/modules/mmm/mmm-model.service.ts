import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, ne, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { mmmSalesDaily, mmmSentimentTrends, mmmModelRuns, mmmChannelResults } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { bizYmdDash } from '../../common/bizdate';
import type { JwtUser } from '../../common/decorators';
import { computeMmm, type MmmChannelInput } from './mmm-model';

// docs/48 — the ANALYTICS write/read path. runModel() reads ONLY MMM-owned staging/core tables (no
// cross-domain join), builds the per-channel inputs, delegates the attribution to the pure computeMmm()
// function, and persists an audited run (inputs + actor + timestamp) with its per-channel result rows.

@Injectable()
export class MmmModelService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly docNo: DocNumberService,
  ) {}

  // Run the model over the last `windowDays`, attributing the analyst-supplied per-channel spend. The total
  // spend is what the "optimal" allocation redistributes by ROI efficiency.
  async runModel(user: JwtUser, opts: { windowDays?: number; spendByChannel?: Record<string, number> }) {
    const tenantId = user.tenantId!;
    const windowDays = Math.min(Math.max(opts.windowDays ?? 30, 1), 365);
    const spendByChannel = opts.spendByChannel ?? {};
    const since = bizYmdDash(new Date(Date.now() - windowDays * 86400_000));

    // Attributed revenue per channel (utm_source), from the sales-daily staging grain.
    const revenueRows = await this.db
      .select({ channel: mmmSalesDaily.utmSource, revenue: sql<number>`sum(${mmmSalesDaily.revenue})`.mapWith(Number) })
      .from(mmmSalesDaily)
      .where(and(eq(mmmSalesDaily.tenantId, tenantId), gte(mmmSalesDaily.bizDate, since), ne(mmmSalesDaily.utmSource, '')))
      .groupBy(mmmSalesDaily.utmSource);

    // Positive-buzz signal per channel (platform), from the sentiment core grain.
    const sentimentRows = await this.db
      .select({
        channel: mmmSentimentTrends.platform,
        signal: sql<number>`sum(${mmmSentimentTrends.mentionCount} * greatest(coalesce(${mmmSentimentTrends.sentimentScore}, 0), 0))`.mapWith(Number),
      })
      .from(mmmSentimentTrends)
      .where(and(eq(mmmSentimentTrends.tenantId, tenantId), gte(mmmSentimentTrends.bizDate, since)))
      .groupBy(mmmSentimentTrends.platform);

    const revByChannel = new Map(revenueRows.map((r) => [r.channel, r.revenue ?? 0]));
    const sigByChannel = new Map(sentimentRows.map((r) => [r.channel, r.signal ?? 0]));

    // The channel universe = every channel that has spend, revenue, or buzz. Sorted for deterministic order.
    const channels = [...new Set([...Object.keys(spendByChannel), ...revByChannel.keys(), ...sigByChannel.keys()])].sort();
    const inputs: MmmChannelInput[] = channels.map((channel) => ({
      channel,
      spend: Number(spendByChannel[channel] ?? 0),
      attributedRevenue: revByChannel.get(channel) ?? 0,
      sentimentSignal: sigByChannel.get(channel) ?? 0,
    }));

    const totalSpend = inputs.reduce((s, i) => s + i.spend, 0);
    const results = computeMmm(inputs, totalSpend);

    const runNo = await this.docNo.nextDaily('MMM');
    const runRows = await this.db.insert(mmmModelRuns)
      .values({
        tenantId, runNo, windowDays, totalSpend: String(totalSpend),
        spendByChannel, status: 'complete', createdBy: user.username,
      })
      .returning({ id: mmmModelRuns.id });
    const runId = runRows[0]!.id;

    if (results.length > 0) {
      await this.db.insert(mmmChannelResults).values(results.map((r) => ({
        tenantId, runId, channel: r.channel,
        spend: String(r.spend),
        attributedRevenue: String(r.attributedRevenue),
        roi: r.roi == null ? null : String(r.roi),
        salesLiftContribution: String(r.salesLiftContribution),
        optimalBudgetAllocation: String(r.optimalBudgetAllocation),
      })));
    }

    return {
      run_no: runNo, window_days: windowDays, total_spend: totalSpend,
      channels: results.length,
      results: results.map((r) => ({
        channel: r.channel, spend: r.spend, attributed_revenue: r.attributedRevenue,
        roi: r.roi, sales_lift_contribution: r.salesLiftContribution, optimal_budget_allocation: r.optimalBudgetAllocation,
      })),
    };
  }

  // GET /api/mmm/runs — recent run headers.
  async listRuns(user: JwtUser, limit = 20) {
    const tenantId = user.tenantId!;
    const rows = await this.db.select().from(mmmModelRuns)
      .where(eq(mmmModelRuns.tenantId, tenantId))
      .orderBy(desc(mmmModelRuns.createdAt)).limit(Math.min(Math.max(limit, 1), 100));
    return { count: rows.length, runs: rows.map((r) => this.runHeader(r)) };
  }

  // GET /api/mmm/runs/:runNo — one run + its channel results. BOLA-safe: filtered by tenant AND run_no.
  async getRun(user: JwtUser, runNo: string) {
    const tenantId = user.tenantId!;
    const runRows = await this.db.select().from(mmmModelRuns)
      .where(and(eq(mmmModelRuns.tenantId, tenantId), eq(mmmModelRuns.runNo, runNo))).limit(1);
    const run = runRows[0];
    if (!run) throw new NotFoundException({ code: 'MMM_RUN_NOT_FOUND', message: 'Model run not found', messageTh: 'ไม่พบผลการรันโมเดล' });
    const results = await this.db.select().from(mmmChannelResults)
      .where(and(eq(mmmChannelResults.tenantId, tenantId), eq(mmmChannelResults.runId, run.id)))
      .orderBy(desc(mmmChannelResults.attributedRevenue));
    return { ...this.runHeader(run), results: results.map((r) => this.resultRow(r)) };
  }

  // The latest run's results — feeds the BI dashboard aggregate + GET /api/bi/mmm-summary.
  async latestSummary(user: JwtUser) {
    const tenantId = user.tenantId!;
    const runRows = await this.db.select().from(mmmModelRuns)
      .where(eq(mmmModelRuns.tenantId, tenantId))
      .orderBy(desc(mmmModelRuns.createdAt)).limit(1);
    const run = runRows[0];
    if (!run) return { has_run: false, run_no: null, results: [] as ReturnType<MmmModelService['resultRow']>[] };
    const results = await this.db.select().from(mmmChannelResults)
      .where(and(eq(mmmChannelResults.tenantId, tenantId), eq(mmmChannelResults.runId, run.id)))
      .orderBy(desc(mmmChannelResults.optimalBudgetAllocation));
    return { has_run: true, ...this.runHeader(run), results: results.map((r) => this.resultRow(r)) };
  }

  private runHeader(r: typeof mmmModelRuns.$inferSelect) {
    return {
      run_no: r.runNo, window_days: r.windowDays, total_spend: Number(r.totalSpend),
      spend_by_channel: r.spendByChannel, status: r.status, created_by: r.createdBy, created_at: r.createdAt,
    };
  }

  private resultRow(r: typeof mmmChannelResults.$inferSelect) {
    return {
      channel: r.channel, spend: Number(r.spend), attributed_revenue: Number(r.attributedRevenue),
      roi: r.roi == null ? null : Number(r.roi),
      sales_lift_contribution: r.salesLiftContribution == null ? null : Number(r.salesLiftContribution),
      optimal_budget_allocation: r.optimalBudgetAllocation == null ? null : Number(r.optimalBudgetAllocation),
    };
  }
}

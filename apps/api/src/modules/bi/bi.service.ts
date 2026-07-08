import { Inject, Injectable, Optional, BadRequestException, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { eq, and, sql, gte, lt, desc, lte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { biDailySnapshots, reportSubscriptions } from '../../database/schema/bi';
import { custPosSales, custPosItems } from '../../database/schema/sales';
import { journalEntries, journalLines, accounts } from '../../database/schema/ledger';
import { arInvoices } from '../../database/schema/finance';
import { apTransactions } from '../../database/schema/finance';
import { opportunities, pipelineStages } from '../../database/schema/pipeline';
import { n, fx } from '../../database/queries';
import { TtlCache } from '../../common/ttl-cache';
import { MessagingService } from '../messaging/messaging.service';
import { LineNotifyService } from '../messaging/line-notify.service';
import { CollectionsService } from '../finance/collections.service';
import { FinanceMetricsService } from '../finance/finance-metrics.service';
import { EamService } from '../eam/eam.service';
import { AssetsService } from '../assets/assets.service';
import { LedgerService } from '../ledger/ledger.service';
import { LeasesService } from '../leases/leases.service';
import { ScheduledChangesService } from '../scheduled-changes/scheduled-changes.service';
import { RevRecService } from '../revenue/revrec.service';
import { ProjectsService } from '../projects/projects.service';
import { RetentionService } from '../retention/retention.service';
import { RealEstateService } from '../realestate/realestate.service';
import { CrmPipelineService } from '../crm/pipeline/crm-pipeline.service';
import { CrmService } from '../crm/crm.service';
import { NpsService } from '../nps/nps.service';
import { MembershipService } from '../loyalty/membership.service';
import { JourneysService } from '../journeys/journeys.service';
import { BudgetService } from '../budget/budget.service';
import { ProcurementService } from '../procurement/procurement.service';
import { ThreeWayMatchService } from '../match/three-way-match.service';
import { JobQueueService } from '../jobs/job-queue.service';
import { JobWorkerService, type JobContext } from '../jobs/job-worker.service';
import { SchedulerHeartbeatService } from '../jobs/scheduler-heartbeat.service';
import { REPORT_TYPES, FREQUENCIES } from './report-registry';
import { BiGenerateService } from './bi-generate.service';
import { BiScheduleService } from './bi-schedule.service';
import { runInTenantContext } from '../../common/tenant-run';
import { BiLiveService } from './bi-live.service';
import { BillingService } from '../billing/billing.service';
import { PdpaService } from '../pdpa/pdpa.service';
import { GovernanceService } from '../governance/governance.service';
import { TaxJobsService } from '../tax/tax-jobs.service';

// Job type for offloading a due report/action subscription to the background worker.
export const REPORT_SUBSCRIPTION_JOB = 'report_subscription';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;



@Injectable()
export class BiService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly messaging: MessagingService,
    // LC-4 (docs/30) — LINE delivery for {line_user} recipients + the line_daily_digest job. Optional so
    // partial harnesses still construct BiService.
    @Optional() private readonly lineNotify?: LineNotifyService,
    // Optional so a partially-wired test harness can construct BiService without the finance graph;
    // the full app always provides it (FinanceModule), enabling the scheduled ar_collections_dunning job.
    @Optional() private readonly collections?: CollectionsService,
    // docs/35 Phase 1 — canonical CFO KPI engine; the exec_scorecard finance leg reads from it so the
    // scorecard and the CFO Command Center never drift. @Optional so a partial harness still constructs.
    @Optional() private readonly financeMetrics?: FinanceMetricsService,
    @Optional() private readonly eam?: EamService,
    // FA-11/FA-12 reporting surfaces: audit results (asset_audit) + the periodic asset-existence exception
    // monitor (asset_verification_exceptions). @Optional so partial harnesses still construct.
    @Optional() private readonly assets?: AssetsService,
    @Optional() private readonly ledger?: LedgerService,
    @Optional() private readonly leases?: LeasesService,
    // Date-effective master changes (Phase 12) — the idempotent apply_scheduled_master_changes action job.
    // @Optional so a partial harness still constructs.
    @Optional() private readonly scheduledChanges?: ScheduledChangesService,
    @Optional() private readonly revrec?: RevRecService,
    // PPM analytics report types (project_evm portfolio EVM, crm_win_loss). Optional so a partial harness
    // still constructs BiService; the full app provides them (ProjectsModule / CrmPipelineModule).
    @Optional() private readonly projects?: ProjectsService,
    // Construction/real-estate scheduled sweeps (docs/35 Depth). @Optional so partial harnesses still build.
    @Optional() private readonly retention?: RetentionService,
    @Optional() private readonly realestate?: RealEstateService,
    @Optional() private readonly crm?: CrmPipelineService,
    // Member CRM (cdp_export_sync action job) — Optional so a partial harness still constructs.
    @Optional() private readonly crmMembers?: CrmService,
    @Optional() private readonly nps?: NpsService, // W3 (docs/27) nps_post_purchase job
    @Optional() private readonly membership?: MembershipService, // V4 (docs/29) membership_revenue_recognize job
    @Optional() private readonly journeys?: JourneysService,
    // Residual-gap report types (RG-1/2/3): exec scorecard composition + budget-variance + supplier scorecard.
    // Optional so a partial harness still constructs; the full app provides BudgetModule/ProcurementModule/MatchModule.
    @Optional() private readonly budget?: BudgetService,
    @Optional() private readonly procurement?: ProcurementService,
    @Optional() private readonly match?: ThreeWayMatchService,
    @Optional() private readonly jobs?: JobQueueService,
    @Optional() private readonly worker?: JobWorkerService,
    // Real-time streaming analytics (docs/22 Phase B) — live KPI/event fan-out bus.
    @Optional() private readonly live?: BiLiveService,
    // Monthly AI-overage billing action job (Wave 1). Optional so a partial harness still constructs; the
    // full app provides BillingModule, enabling the scheduled ai_overage_billing job.
    @Optional() private readonly billing?: BillingService,
    // PII retention sweep (PDPA-04) — opt-in anonymization of aged loyalty-member PII. Optional so a
    // partial harness still constructs; the full app provides PdpaModule.
    @Optional() private readonly pdpa?: PdpaService,
    // full app provides GovernanceModule, enabling the scheduled governance_readiness reminder job.
    @Optional() private readonly governance?: GovernanceService,
    // Scheduled tax automation (docs/33 PR4). Optional so a partial harness still constructs; the full app
    // provides TaxJobsModule, enabling the tax_wht_cert_batch / tax_*_draft / tax_remittance_reminder jobs.
    @Optional() private readonly taxJobs?: TaxJobsService,
    // docs/27 R1-5 — due-sweep liveness stamp. Optional so partial harnesses still construct BiService.
    @Optional() private readonly schedHeartbeat?: SchedulerHeartbeatService,
    // docs/38 pilot PR-2 — APPENDED (param 31): the goldenmaster harness constructs BiService positionally,
    // so existing param order is a hard contract; new params only ever append.
    @Optional() private readonly generateSvc?: BiGenerateService,
    @Optional() private readonly scheduleSvc?: BiScheduleService,
  ) {}

  // Register the background handler that runs one due subscription (report or heavy action job) off the
  // request path. The worker claims jobs with FOR UPDATE SKIP LOCKED + retry/backoff; runInTenantContext
  // (set by the worker) scopes the handler to the job's tenant, so we reconstruct a minimal principal here.
  onModuleInit(): void {
    this.worker?.register(REPORT_SUBSCRIPTION_JOB, async (payload: { subscriptionId: number }, ctx: JobContext) => {
      const db = this.db;
      const [sub] = await db.select().from(reportSubscriptions).where(eq(reportSubscriptions.id, Number(payload.subscriptionId))).limit(1);
      if (!sub) return { skipped: 'subscription not found' };
      // Multi-trigger safety (2.7): the external cron, a manual sweep and the in-process tick can all
      // enqueue the same due subscription before its first run advances next_run_at — re-check dueness at
      // EXECUTION time so a duplicate enqueue no-ops instead of double-delivering. ("Run now" bypasses the
      // queue entirely, so this only ever skips schedule-driven duplicates.)
      if (sub.lastRunAt && (!sub.nextRunAt || new Date(sub.nextRunAt as unknown as string).getTime() > Date.now())) {
        return { skipped: 'not due', subscription_id: Number(sub.id) };
      }
      const user = { username: ctx.actor ?? 'system:scheduler', role: ctx.bypass ? 'Admin' : 'Sales', tenantId: ctx.tenantId ?? sub.tenantId, permissions: [], customerName: null } as unknown as JwtUser;
      return this.scheduleOrThrow().executeSubscription(sub, user, this);
    });
  }



  // ── Read-through cache for the dashboard aggregates ─────────────────────────
  // The KPI board / sales cube / finance & pipeline trends are read-only roll-ups hit on every dashboard
  // load; they re-scan sales/AR/AP/GL/pipeline each time. Cache them for a short TTL (default 30s) so a
  // burst of dashboard polls collapses to one query set per tenant per window. TTL is read per-call from
  // BI_CACHE_TTL_MS (0 disables) so it can be tuned per deploy without a redeploy. The key ALWAYS includes
  // the tenant id → no cross-tenant leakage.
  private readonly cache = new TtlCache();
  private get cacheTtlMs(): number { return Number(process.env.BI_CACHE_TTL_MS ?? 30000); }
  private cacheKey(method: string, tid: number, dto: unknown): string {
    return `bi:${tid}:${method}:${JSON.stringify(dto ?? {})}`;
  }
  // Invalidate every cached board for a tenant (called when a snapshot refresh changes the underlying data).
  private bustTenant(tid: number): void { this.cache.deletePrefix(`bi:${tid}:`); }

  // ── KPI Board ─────────────────────────────────────────────────────────────
  // Real-time cross-domain aggregation for the AI copilot dashboard

  kpiBoard(user: JwtUser) {
    return this.cache.wrap(this.cacheKey('kpiBoard', user.tenantId!, null), this.cacheTtlMs, () => this.kpiBoardUncached(user));
  }
  private async kpiBoardUncached(user: JwtUser) {
    const db = this.db;
    const tid = user.tenantId!;
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 7) + '-01';
    const yearStart = today.slice(0, 4) + '-01-01';

    // MTD sales
    const [mtdSales] = await db.select({
      total: sql<string>`coalesce(sum(${custPosSales.total}),0)`,
      count: sql<string>`count(*)`,
    }).from(custPosSales).where(and(eq(custPosSales.tenantId, tid), gte(custPosSales.saleDate, monthStart)));

    // YTD sales
    const [ytdSales] = await db.select({
      total: sql<string>`coalesce(sum(${custPosSales.total}),0)`,
    }).from(custPosSales).where(and(eq(custPosSales.tenantId, tid), gte(custPosSales.saleDate, yearStart)));

    // Open AR
    const [openAr] = await db.select({
      total: sql<string>`coalesce(sum(${arInvoices.amount} - ${arInvoices.paidAmount}),0)`,
    }).from(arInvoices).where(and(eq(arInvoices.tenantId, tid), eq(arInvoices.status, 'Unpaid')));

    // Open AP
    const [openAp] = await db.select({
      total: sql<string>`coalesce(sum(${apTransactions.amount}),0)`,
    }).from(apTransactions).where(and(eq(apTransactions.tenantId, tid), eq(apTransactions.txnType, 'Bill')));

    // Overdue AR (due < today)
    const [overdueAr] = await db.select({
      count: sql<string>`count(*)`,
      total: sql<string>`coalesce(sum(${arInvoices.amount} - ${arInvoices.paidAmount}),0)`,
    }).from(arInvoices).where(and(eq(arInvoices.tenantId, tid), eq(arInvoices.status, 'Unpaid'), lt(arInvoices.dueDate, today)));

    // Open pipeline
    const [pipeline] = await db.select({
      total: sql<string>`coalesce(sum(${opportunities.expectedValue}),0)`,
      weighted: sql<string>`coalesce(sum(${opportunities.expectedValue} * ${pipelineStages.defaultProbability} / 100.0),0)`,
      count: sql<string>`count(*)`,
    }).from(opportunities)
      .innerJoin(pipelineStages, eq(opportunities.stageId, pipelineStages.id))
      .where(and(eq(opportunities.tenantId, tid), eq(opportunities.status, 'Open')));

    return {
      as_of: today,
      sales: {
        mtd: round2(n(mtdSales!.total)), mtd_orders: Number(mtdSales!.count),
        ytd: round2(n(ytdSales!.total)),
        avg_order_mtd: Number(mtdSales!.count) > 0 ? round2(n(mtdSales!.total) / Number(mtdSales!.count)) : 0,
      },
      receivables: {
        open_ar: round2(n(openAr!.total)),
        overdue_ar: round2(n(overdueAr!.total)),
        overdue_count: Number(overdueAr!.count),
      },
      payables: { open_ap: round2(n(openAp!.total)) },
      pipeline: {
        open_value: round2(n(pipeline!.total)),
        weighted_value: round2(n(pipeline!.weighted)),
        open_count: Number(pipeline!.count),
      },
    };
  }

  // ── Sales Cube ─────────────────────────────────────────────────────────────
  // Breakdown by period (day | week | month) with optional group_by (channel | none)

  salesCube(dto: { period?: 'day' | 'week' | 'month'; start_date?: string; end_date?: string; months?: number }, user: JwtUser) {
    return this.cache.wrap(this.cacheKey('salesCube', user.tenantId!, dto), this.cacheTtlMs, () => this.salesCubeUncached(dto, user));
  }
  private async salesCubeUncached(dto: { period?: 'day' | 'week' | 'month'; start_date?: string; end_date?: string; months?: number }, user: JwtUser) {
    const db = this.db;
    const tid = user.tenantId!;
    const months = dto.months ?? 3;
    const today = new Date().toISOString().slice(0, 10);
    const start = dto.start_date ?? this.monthsAgo(today, months);
    const end = dto.end_date ?? today;
    const period = dto.period ?? 'month';

    // Validate the period explicitly: an unknown value used to silently coerce to 'month' (a
    // silent-wrong-result — the caller asked for one grain and got another). Reject it instead.
    // This also keeps the `sql.raw(truncFn)` sites below provably injection-safe by construction:
    // truncFn can only ever be one of the three hardcoded date_trunc field literals.
    const TRUNC: Record<string, 'day' | 'week' | 'month'> = { day: 'day', week: 'week', month: 'month' };
    const truncFn = TRUNC[period];
    if (!truncFn) throw new BadRequestException({ code: 'BI_BAD_PERIOD', message: `Invalid period '${period}' — expected day, week, or month`, messageTh: "ช่วงเวลาไม่ถูกต้อง — รองรับเฉพาะ day, week หรือ month" });

    const rows = await db.select({
      period: sql<string>`to_char(date_trunc('${sql.raw(truncFn)}', ${custPosSales.saleDate}::date), 'YYYY-MM-DD')`,
      total_sales: sql<string>`coalesce(sum(${custPosSales.total}),0)`,
      total_orders: sql<string>`count(*)`,
      avg_order: sql<string>`coalesce(avg(${custPosSales.total}),0)`,
      total_tax: sql<string>`coalesce(sum(${custPosSales.taxAmount}),0)`,
    }).from(custPosSales)
      .where(and(eq(custPosSales.tenantId, tid), gte(custPosSales.saleDate, start), lte(custPosSales.saleDate, end)))
      .groupBy(sql`date_trunc('${sql.raw(truncFn)}', ${custPosSales.saleDate}::date)`)
      .orderBy(sql`date_trunc('${sql.raw(truncFn)}', ${custPosSales.saleDate}::date)`);

    return {
      period_type: period, start, end,
      rows: rows.map((r: any) => ({
        period: r.period, total_sales: round2(n(r.total_sales)),
        total_orders: Number(r.total_orders), avg_order: round2(n(r.avg_order)),
        total_tax: round2(n(r.total_tax)),
      })),
      totals: {
        total_sales: round2(rows.reduce((s: number, r: any) => s + n(r.total_sales), 0)),
        total_orders: rows.reduce((s: number, r: any) => s + Number(r.total_orders), 0),
      },
    };
  }

  // ── Finance Trend ──────────────────────────────────────────────────────────
  // Monthly P&L trend from GL journal lines

  financeTrend(dto: { months?: number; ledger_code?: string }, user: JwtUser) {
    return this.cache.wrap(this.cacheKey('financeTrend', user.tenantId!, dto), this.cacheTtlMs, () => this.financeTrendUncached(dto, user));
  }
  private async financeTrendUncached(dto: { months?: number; ledger_code?: string }, user: JwtUser) {
    const db = this.db;
    const tid = user.tenantId!;
    const months = dto.months ?? 6;
    const today = new Date().toISOString().slice(0, 10);
    const start = this.monthsAgo(today, months);
    const ledgerFilter = dto.ledger_code
      ? sql`(${journalEntries.ledgerCode} IS NULL OR ${journalEntries.ledgerCode} = ${dto.ledger_code})`
      : sql`${journalEntries.ledgerCode} IS NULL`;

    // Revenue/expense per period in ONE grouped query: JOIN accounts (typed) + CASE-WHEN SUM, instead of a
    // correlated `(SELECT type FROM accounts WHERE code = …)` subquery fired per GROUP BY bucket plus an
    // in-memory roll-up loop (the old N+1 re-scanned `accounts` for every period × account-type bucket and
    // marshalled all rows to the app). Revenue = Σ(credit − debit) on Revenue accounts; expense =
    // Σ(debit − credit) on Expense accounts — identical to the previous net-then-negate maths. The INNER
    // JOIN drops lines whose account isn't in the COA, exactly as the old NULL account_type did.
    const rows = await db.select({
      period: journalEntries.period,
      revenue: sql<string>`coalesce(sum(case when ${accounts.type} = 'Revenue' then ${journalLines.credit} - ${journalLines.debit} else 0 end),0)`,
      expense: sql<string>`coalesce(sum(case when ${accounts.type} = 'Expense' then ${journalLines.debit} - ${journalLines.credit} else 0 end),0)`,
    }).from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .innerJoin(accounts, eq(journalLines.accountCode, accounts.code))
      .where(and(
        eq(journalEntries.tenantId, tid),
        eq(journalEntries.status, 'Posted'),
        gte(journalEntries.entryDate, start),
        ledgerFilter,
      ))
      .groupBy(journalEntries.period)
      .orderBy(journalEntries.period);

    const trend = rows.map((r: any) => {
      const revenue = round2(n(r.revenue));
      const expense = round2(n(r.expense));
      return {
        period: r.period ?? 'unknown',
        revenue,
        expense,
        gross_profit: round2(revenue - expense),
        margin_pct: revenue > 0 ? round2((revenue - expense) / revenue * 100) : 0,
      };
    });

    return { months, trend };
  }

  // ── Pipeline Trend ─────────────────────────────────────────────────────────
  // Open pipeline + Win/Lost breakdown by month created

  pipelineTrend(dto: { months?: number }, user: JwtUser) {
    return this.cache.wrap(this.cacheKey('pipelineTrend', user.tenantId!, dto), this.cacheTtlMs, () => this.pipelineTrendUncached(dto, user));
  }
  private async pipelineTrendUncached(dto: { months?: number }, user: JwtUser) {
    const db = this.db;
    const tid = user.tenantId!;
    const months = dto.months ?? 6;
    const today = new Date().toISOString().slice(0, 10);
    const start = this.monthsAgo(today, months);

    const rows = await db.select({
      month: sql<string>`to_char(date_trunc('month', ${opportunities.createdAt}), 'YYYY-MM')`,
      status: opportunities.status,
      count: sql<string>`count(*)`,
      value: sql<string>`coalesce(sum(${opportunities.expectedValue}),0)`,
    }).from(opportunities)
      .where(and(eq(opportunities.tenantId, tid), gte(opportunities.createdAt, new Date(start + 'T00:00:00Z'))))
      .groupBy(sql`date_trunc('month', ${opportunities.createdAt})`, opportunities.status)
      .orderBy(sql`date_trunc('month', ${opportunities.createdAt})`);

    const byMonth: Record<string, any> = {};
    for (const r of rows) {
      const m = r.month;
      if (!byMonth[m]) byMonth[m] = { month: m, open: 0, won: 0, lost: 0, open_value: 0, won_value: 0, total_created: 0 };
      byMonth[m].total_created += Number(r.count);
      if (r.status === 'Open') { byMonth[m].open += Number(r.count); byMonth[m].open_value += n(r.value); }
      if (r.status === 'Won')  { byMonth[m].won  += Number(r.count); byMonth[m].won_value  += n(r.value); }
      if (r.status === 'Lost') { byMonth[m].lost += Number(r.count); }
    }

    return {
      months,
      trend: Object.values(byMonth).map((m: any) => ({
        ...m, open_value: round2(m.open_value), won_value: round2(m.won_value),
        win_rate_pct: m.total_created > 0 ? round2(m.won / m.total_created * 100) : 0,
      })),
    };
  }

  // ── Sales Cube Drill-down ──────────────────────────────────────────────────
  // Top-selling items for a date range — clicked from the sales cube bar chart.

  async salesCubeTopItems(dto: { start_date?: string; end_date?: string; months?: number; limit?: number }, user: JwtUser) {
    const db = this.db;
    const tid = user.tenantId!;
    const months = dto.months ?? 1;
    const today = new Date().toISOString().slice(0, 10);
    const start = dto.start_date ?? this.monthsAgo(today, months);
    const end = dto.end_date ?? today;
    const limit = Math.min(dto.limit ?? 20, 100);

    const rows = await db.select({
      item_id: custPosItems.itemId,
      item_description: custPosItems.itemDescription,
      qty: sql<string>`coalesce(sum(${custPosItems.qty}),0)`,
      revenue: sql<string>`coalesce(sum(${custPosItems.amount}),0)`,
      tx_count: sql<string>`count(distinct ${custPosSales.id})`,
    }).from(custPosItems)
      .innerJoin(custPosSales, eq(custPosItems.saleId, custPosSales.id))
      .where(and(eq(custPosSales.tenantId, tid), gte(custPosSales.saleDate, start), lte(custPosSales.saleDate, end)))
      .groupBy(custPosItems.itemId, custPosItems.itemDescription)
      .orderBy(desc(sql`coalesce(sum(${custPosItems.amount}),0)`))
      .limit(limit);

    return {
      start, end,
      items: rows.map((r: any) => ({
        item_id: r.item_id ?? '—', item_description: r.item_description ?? '—',
        qty: round2(n(r.qty)), revenue: round2(n(r.revenue)), tx_count: Number(r.tx_count),
      })),
      count: rows.length,
    };
  }

  // ── Snapshot Refresh + Retrieval ───────────────────────────────────────────

  async refreshSnapshot(dto: { date?: string }, user: JwtUser) {
    const db = this.db;
    const tid = user.tenantId!;
    const date = dto.date ?? new Date().toISOString().slice(0, 10);

    // A manual snapshot refresh is an explicit "recompute now" — drop any cached boards for this tenant so
    // the snapshot (and the next dashboard read) reflect the latest data, not a value up to 30s stale.
    this.bustTenant(tid);
    const kpi = await this.kpiBoard(user);

    const row = {
      tenantId: tid, snapshotDate: date,
      totalSales: fx(kpi.sales.mtd, 4),
      totalOrders: kpi.sales.mtd_orders,
      avgOrderValue: fx(kpi.sales.avg_order_mtd, 4),
      grossProfit: '0',
      grossMarginPct: '0',
      openAr: fx(kpi.receivables.open_ar, 4),
      openAp: fx(kpi.payables.open_ap, 4),
      inventoryValue: '0',
      pipelineValue: fx(kpi.pipeline.open_value, 4),
      weightedPipeline: fx(kpi.pipeline.weighted_value, 4),
    };

    await db.insert(biDailySnapshots).values(row)
      .onConflictDoUpdate({
        target: [biDailySnapshots.tenantId, biDailySnapshots.snapshotDate],
        set: { ...row, createdAt: new Date() },
      });

    // Streaming analytics (Phase B): push the refreshed KPI snapshot live to any subscribed dashboard.
    this.publishLive({ type: 'kpi_refresh', tenant_id: tid, date, kpi: { sales_mtd: kpi.sales.mtd, open_ar: kpi.receivables.open_ar, open_ap: kpi.payables.open_ap, pipeline_open: kpi.pipeline.open_value } });
    // docs/35 Phase 2: nudge the CFO Command Center too — a compact finance-KPI headline (+ red-flag count)
    // so the scorecard tiles refresh live off the same bus. Best-effort; skipped if the engine isn't wired.
    if (this.financeMetrics) {
      const fin = await this.financeMetrics.execFinance({ tenantId: tid } as JwtUser).catch(() => null);
      if (fin) this.publishLive({ type: 'fin_kpi_refresh', tenant_id: tid, date, fin: { net_margin_pct: fin.net_margin_pct, current_ratio: fin.current_ratio, dso: fin.dso, red_flags: fin.red_flags?.length ?? 0 } });
    }
    return { date, snapshot: row };
  }

  // Publish a live analytics event to the SSE bus (no-op if the bus isn't wired, e.g. a partial harness).
  publishLive(event: { type: string; tenant_id?: number | null; [k: string]: any }): void {
    this.live?.publish(event);
  }
  // Buffered recent feed for a tenant — the HTTP-testable read behind the SSE stream.
  liveRecent(user: JwtUser, limit?: number) {
    return { events: this.live?.recent(user.tenantId ?? null, limit) ?? [], available: !!this.live };
  }
  // The raw event stream (per-tenant filtered) for the @Sse controller.
  liveStream() {
    return this.live?.stream();
  }

  async getSnapshots(dto: { start_date?: string; end_date?: string; days?: number }, user: JwtUser) {
    const db = this.db;
    const tid = user.tenantId!;
    const today = new Date().toISOString().slice(0, 10);
    const days = dto.days ?? 30;
    const start = dto.start_date ?? this.daysAgo(today, days);
    const end = dto.end_date ?? today;

    const rows = await db.select().from(biDailySnapshots)
      .where(and(eq(biDailySnapshots.tenantId, tid), gte(biDailySnapshots.snapshotDate, start), lte(biDailySnapshots.snapshotDate, end)))
      .orderBy(biDailySnapshots.snapshotDate);

    return {
      start, end,
      snapshots: rows.map((r: any) => ({
        date: r.snapshotDate, total_sales: n(r.totalSales), total_orders: r.totalOrders,
        avg_order_value: n(r.avgOrderValue), open_ar: n(r.openAr), open_ap: n(r.openAp),
        pipeline_value: n(r.pipelineValue), weighted_pipeline: n(r.weightedPipeline),
      })),
      count: rows.length,
    };
  }

  // ── Report Subscriptions ───────────────────────────────────────────────────

  reportTypes() {
    return { report_types: Object.entries(REPORT_TYPES).map(([key, v]) => ({ key, label: v.label, label_en: v.labelEn })), frequencies: FREQUENCIES };
  }

  // ── docs/38 pilot PR-3: the subscription scheduler lives in BiScheduleService; every public method stays
  // here as a thin delegator (public API byte-identical), passing `this` as the BiReadPort for generation.
  private scheduleOrThrow(): BiScheduleService {
    if (!this.scheduleSvc) throw new BadRequestException({ code: 'SCHEDULE_UNAVAILABLE', message: 'Report scheduler service not available', messageTh: 'ระบบตั้งเวลารายงานไม่พร้อมใช้งาน' });
    return this.scheduleSvc;
  }
  async runDueAsync(user: JwtUser) { return this.scheduleOrThrow().runDueAsync(user, this); }
  async runDueAllAsync(actor = 'system:scheduler') { return this.scheduleOrThrow().runDueAllAsync(this, actor); }
  async createSubscription(dto: { name: string; report_type: string; frequency: string; filters?: object; recipients?: object[] }, user: JwtUser) { return this.scheduleOrThrow().createSubscription(dto, user); }
  async listSubscriptions(user: JwtUser) { return this.scheduleOrThrow().listSubscriptions(user); }
  async deleteSubscription(id: number, user: JwtUser) { return this.scheduleOrThrow().deleteSubscription(id, user); }
  async runDue(user: JwtUser) { return this.scheduleOrThrow().runDue(user, this); }
  async runSubscriptionNow(id: number, user: JwtUser) { return this.scheduleOrThrow().runSubscriptionNow(id, user, this); }
  async listRuns(user: JwtUser, limit = 100) { return this.scheduleOrThrow().listRuns(user, limit); }




  // ── Scheduled-report execution engine ──────────────────────────────────────
  // Generate the payload + a one-line summary (TH/EN) for a report type. Reuses the live aggregations above.

  // Executive cross-module scorecard (RG-1): a read-only composition of signals that already exist across
  // finance / CRM / projects / supply-chain into one health board. Every leg is guarded — a module the harness
  // didn't wire degrades to nulls rather than throwing, so a partial deployment still renders the board.





  // ── Helpers ───────────────────────────────────────────────────────────────

  private monthsAgo(today: string, months: number): string {
    const d = new Date(today + 'T00:00:00Z');
    d.setMonth(d.getMonth() - months);
    return d.toISOString().slice(0, 10);
  }

  private daysAgo(today: string, days: number): string {
    const d = new Date(today + 'T00:00:00Z');
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }


}

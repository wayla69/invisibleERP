import { Inject, Injectable, Optional, BadRequestException, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { eq, and, sql, gte, lt, desc, lte } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { biDailySnapshots, reportSubscriptions, reportRuns } from '../../database/schema/bi';
import { notifications } from '../../database/schema/system';
import { custPosSales, custPosItems } from '../../database/schema/sales';
import { journalEntries, journalLines, accounts } from '../../database/schema/ledger';
import { arInvoices } from '../../database/schema/finance';
import { apTransactions } from '../../database/schema/finance';
import { opportunities, pipelineStages } from '../../database/schema/pipeline';
import { DIGEST_KPIS, DEFAULT_DIGEST_KPIS, allowedDigestKpis } from './digest-kpis';
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
import { runInTenantContext } from '../../common/tenant-run';
import { BiLiveService } from './bi-live.service';
import { BillingService } from '../billing/billing.service';
import { PdpaService } from '../pdpa/pdpa.service';
import { GovernanceService } from '../governance/governance.service';
import { TaxJobsService } from '../tax/tax-jobs.service';
import { captureOpsAlert } from '../../observability/instrumentation';

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
      return this.executeSubscription(sub, user);
    });
  }

  // Async scheduler: enqueue each DUE subscription as a background job (returns immediately) instead of
  // running them inline. Heavy action jobs (dunning, recurring GL, lease/rev-rec runs) then execute on the
  // worker with retry/backoff, off the cron request path. Falls back to inline runDue if the queue is absent.
  async runDueAsync(user: JwtUser) {
    if (!this.jobs) return { ...(await this.runDue(user)), mode: 'inline (queue unavailable)' };
    const db = this.db;
    const now = Date.now();
    const subs = await db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.tenantId, user.tenantId!), eq(reportSubscriptions.isActive, true)));
    const due = subs.filter((s: any) => !s.lastRunAt || (s.nextRunAt && new Date(s.nextRunAt).getTime() <= now));
    const enqueued: number[] = [];
    for (const sub of due) {
      const jobId = await this.jobs.enqueue({ jobType: REPORT_SUBSCRIPTION_JOB, payload: { subscriptionId: Number(sub.id) }, tenantId: user.tenantId ?? null, actor: user.username, bypass: user.role === 'Admin' });
      enqueued.push(jobId);
    }
    await this.schedHeartbeat?.beat('bi_scheduler', 'runDueAsync', { due: due.length });
    return { due: due.length, enqueued: enqueued.length, job_ids: enqueued, mode: 'queued' };
  }

  // 2.7 — the CROSS-TENANT due sweep. runDue/runDueAsync are scoped to the CALLER's tenant, so on a
  // multi-company deploy the nightly cron (authenticated as one service account) only ever swept its own
  // tenant — every other tenant's subscriptions silently never fired. This sweep runs under a bypass
  // context, selects every active due subscription platform-wide, and enqueues each one under ITS OWN
  // tenant (the worker executes it RLS-scoped there, exactly like a request from that tenant). Counts
  // only in the response — no cross-tenant row data leaves this method. Inline fallback without the queue.
  async runDueAllAsync(actor = 'system:scheduler') {
    return runInTenantContext(this.db, { tenantId: null, bypass: true, actor }, async () => {
      const db = this.db;
      const now = Date.now();
      const subs = await db.select().from(reportSubscriptions).where(eq(reportSubscriptions.isActive, true));
      const due = subs.filter((s: any) => !s.lastRunAt || (s.nextRunAt && new Date(s.nextRunAt).getTime() <= now));
      let enqueued = 0, ranInline = 0;
      for (const sub of due) {
        if (this.jobs) {
          await this.jobs.enqueue({ jobType: REPORT_SUBSCRIPTION_JOB, payload: { subscriptionId: Number(sub.id) }, tenantId: sub.tenantId ?? null, actor, bypass: false });
          enqueued++;
        } else {
          const user = { username: actor, role: 'Sales', tenantId: sub.tenantId, permissions: [], customerName: null } as unknown as JwtUser;
          await this.executeSubscription(sub, user);
          ranInline++;
        }
      }
      await this.schedHeartbeat?.beat('bi_scheduler', 'runDueAllAsync', { due: due.length });
      return { due: due.length, enqueued, ran_inline: ranInline, mode: this.jobs ? 'queued' : 'inline (queue unavailable)' };
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

  // docs/38 pilot PR-2: generation lives in BiGenerateService; this thin delegator preserves the private
  // call sites (executeSubscription) and passes `this` as the BiReadPort (the cached read core stays here).
  private async generateReport(reportType: string, filters: any, user: JwtUser): Promise<{ data: any; summary: string; summaryTh: string }> {
    if (!this.generateSvc) throw new BadRequestException({ code: 'GENERATE_UNAVAILABLE', message: 'Report generation service not available', messageTh: 'ระบบสร้างรายงานไม่พร้อมใช้งาน' });
    return this.generateSvc.generateReport(reportType, filters, user, this);
  }

  async createSubscription(dto: { name: string; report_type: string; frequency: string; filters?: object; recipients?: object[] }, user: JwtUser) {
    const db = this.db;
    if (!REPORT_TYPES[dto.report_type]) throw new BadRequestException({ code: 'BAD_REPORT_TYPE', message: `Unknown report type '${dto.report_type}'`, messageTh: 'ไม่รู้จักประเภทรายงานนี้' });
    if (!(FREQUENCIES as readonly string[]).includes(dto.frequency)) throw new BadRequestException({ code: 'BAD_FREQUENCY', message: 'frequency must be daily|weekly|monthly', messageTh: 'ความถี่ต้องเป็น รายวัน/รายสัปดาห์/รายเดือน' });
    const nextRun = this.nextRunDate(dto.frequency);
    const [sub] = await db.insert(reportSubscriptions).values({
      tenantId: user.tenantId!, name: dto.name, reportType: dto.report_type,
      frequency: dto.frequency, filters: dto.filters ?? {}, recipients: dto.recipients ?? [],
      isActive: true, nextRunAt: nextRun, createdBy: user.username,
    }).returning();
    return this.fmtSub(sub);
  }

  async listSubscriptions(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.tenantId, user.tenantId!), eq(reportSubscriptions.isActive, true)))
      .orderBy(desc(reportSubscriptions.createdAt));
    return { subscriptions: rows.map((s: any) => this.fmtSub(s)), count: rows.length };
  }

  async deleteSubscription(id: number, user: JwtUser) {
    const db = this.db;
    await db.update(reportSubscriptions).set({ isActive: false })
      .where(and(eq(reportSubscriptions.id, id), eq(reportSubscriptions.tenantId, user.tenantId!)));
    return { deleted: id };
  }

  // ── Scheduled-report execution engine ──────────────────────────────────────
  // Generate the payload + a one-line summary (TH/EN) for a report type. Reuses the live aggregations above.

  // Executive cross-module scorecard (RG-1): a read-only composition of signals that already exist across
  // finance / CRM / projects / supply-chain into one health board. Every leg is guarded — a module the harness
  // didn't wire degrades to nulls rather than throwing, so a partial deployment still renders the board.

  // Execute one subscription: generate → deliver (email recipients + in-app notification) → log a run →
  // advance the schedule. Delivery is best-effort; the run is always recorded.
  private async executeSubscription(sub: any, user: JwtUser) {
    const db = this.db;
    try {
      const report = await this.generateReport(sub.reportType, sub.filters, user);
      const recipients = Array.isArray(sub.recipients) ? sub.recipients : [];
      let delivered = 0;
      for (const r of recipients) {
        // LC-4: {line_user:'<username>'} delivers a compact summary to that staff user's LINKED LINE
        // (resolution follows the link registry; unlinked users silently receive nothing).
        if (r?.line_user && this.lineNotify) {
          try {
            const tenantIdN = sub.tenantId != null ? Number(sub.tenantId) : null;
            if (sub.reportType === 'line_daily_digest') {
              // LP-3: per-recipient KPI selection ∩ effective permissions AT SEND TIME — a perm revoked
              // after subscribing silently drops that KPI from this person's message. Flex card + altText.
              const perms = await this.lineNotify.effectivePermsOf(String(r.line_user));
              const chosen: string[] = Array.isArray(r?.kpis) && r.kpis.length ? r.kpis.map(String) : DEFAULT_DIGEST_KPIS;
              const visible = chosen.filter((k) => allowedDigestKpis(perms).includes(k));
              const fmt = (k: string) => {
                const v = (report.data as Record<string, unknown> | undefined)?.[k];
                if (v == null) return '—'; // zero-data honesty: missing ≠ 0
                return DIGEST_KPIS[k]?.money ? Number(v).toLocaleString('th-TH', { maximumFractionDigits: 2 }) : String(v);
              };
              const rows = visible.map((k) => ({ th: DIGEST_KPIS[k]!.th, val: fmt(k) }));
              const text = `📊 ${sub.name}: ` + (rows.length ? rows.map((x) => `${x.th} ${x.val}`).join(' · ') : 'ไม่มีรายการที่คุณมีสิทธิ์เห็น') + '\nดูรายงานเต็มที่หน้า /bi';
              const flex = {
                type: 'bubble',
                body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
                  { type: 'text', text: `📊 ${sub.name}`, weight: 'bold', size: 'md' },
                  ...rows.map((x) => ({ type: 'box', layout: 'horizontal', contents: [
                    { type: 'text', text: x.th, size: 'sm', color: '#666666', flex: 5 },
                    { type: 'text', text: x.val, size: 'sm', weight: 'bold', align: 'end', flex: 4 },
                  ] })),
                  { type: 'text', text: 'ดูรายงานเต็มที่หน้า /bi', size: 'xs', color: '#888888' },
                ] },
              };
              await this.lineNotify.notifyUser(String(r.line_user), tenantIdN, text, flex);
            } else if (sub.reportType === 'low_stock_reorder_alert') {
              // D1 — list the low-stock items + a one-tap [สั่งเติมทั้งหมด] postback ({a:'reorder'}). Only
              // pushed when something is actually low, so quiet mornings stay silent (no noise).
              const d = (report.data ?? {}) as { count?: number; items?: Array<{ item_id: string; on_hand: number; min_stock: number; uom: string | null; suggested_qty: number }> };
              const low = d.items ?? [];
              if (!low.length) { continue; }
              const total = d.count ?? low.length;
              const rows = low.slice(0, 10).map((x) => `• ${x.item_id} — เหลือ ${x.on_hand}${x.uom ? ` ${x.uom}` : ''} (จุดสั่งซื้อ ${x.min_stock}) → แนะนำ ${x.suggested_qty}`);
              const more = low.length > 10 ? `\n…และอีก ${low.length - 10} รายการ` : '';
              const text = `🛒 สินค้าใกล้หมด ${total} รายการ\n${rows.join('\n')}${more}\nพิมพ์ reorder หรือกดปุ่มเพื่อเปิด PR เติมทั้งหมด`;
              const flex = {
                type: 'bubble',
                body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
                  { type: 'text', text: `🛒 สินค้าใกล้หมด (${total})`, weight: 'bold', size: 'md', wrap: true },
                  ...low.slice(0, 10).map((x) => ({ type: 'box', layout: 'horizontal', contents: [
                    { type: 'text', text: x.item_id, size: 'sm', color: '#666666', flex: 6, wrap: true },
                    { type: 'text', text: `เหลือ ${x.on_hand}`, size: 'sm', weight: 'bold', align: 'end', flex: 4 },
                  ] })),
                  ...(low.length > 10 ? [{ type: 'text', text: `…และอีก ${low.length - 10} รายการ`, size: 'xs', color: '#888888' }] : []),
                ] },
                footer: { type: 'box', layout: 'vertical', contents: [
                  { type: 'button', style: 'primary', height: 'sm', action: { type: 'postback', label: '🛒 สั่งเติมทั้งหมด', data: JSON.stringify({ a: 'reorder' }), displayText: 'reorder' } },
                ] },
              };
              await this.lineNotify.notifyUser(String(r.line_user), tenantIdN, text, flex);
            } else {
              await this.lineNotify.notifyUser(String(r.line_user), tenantIdN, `📊 ${sub.name}: ${report.summaryTh ?? report.summary}\nดูรายงานเต็มที่หน้า /bi`);
            }
            delivered++;
          } catch { /* best-effort */ }
          continue;
        }
        const to = r?.email;
        if (!to) continue;
        try { const res: any = await this.messaging.send({ to, channel: 'email', body: `${sub.name}: ${report.summary}`, campaign: 'report' }, user); if (res?.status === 'sent') delivered++; } catch { /* best-effort */ }
      }
      // in-app notification to the tenant
      await db.insert(notifications).values({ targetTenantId: sub.tenantId, targetRole: null, message: `รายงาน ${sub.name}: ${report.summaryTh}`, messageEn: `Report ${sub.name}: ${report.summary}` });
      const [run] = await db.insert(reportRuns).values({
        tenantId: sub.tenantId, subscriptionId: Number(sub.id), name: sub.name, reportType: sub.reportType,
        frequency: sub.frequency, status: 'success', recipientsCount: delivered, summary: report.data,
      }).returning({ id: reportRuns.id });
      await db.update(reportSubscriptions).set({ lastRunAt: new Date(), nextRunAt: this.nextRunDate(sub.frequency) }).where(eq(reportSubscriptions.id, sub.id));
      return { run_id: Number(run!.id), subscription_id: Number(sub.id), name: sub.name, report_type: sub.reportType, status: 'success', delivered, summary: report.summary };
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      // ITGC-OP-04 — a scheduled (often FINANCIAL) job that fails must never be SILENT. executeSubscription
      // swallows the error (returns status:'failed' instead of throwing) so the failure would otherwise be
      // invisible at the alerting layer — and when run async via the worker, the swallowed error would mark
      // the background job 'done'. So we (a) emit an ops alert (structured log + Sentry — routes to on-call,
      // reusing the #264 sink) and (b) raise an operator-facing in-app notification, in addition to recording
      // the failed run for review (GET /api/bi/runs). Both are best-effort and never mask the original failure.
      captureOpsAlert('scheduled_job_failed', { subscriptionId: Number(sub.id), reportType: sub.reportType, tenantId: sub.tenantId, name: sub.name }, e);
      try {
        await db.insert(notifications).values({
          targetTenantId: sub.tenantId, targetRole: 'Admin',
          message: `งานตั้งเวลาล้มเหลว: ${sub.name} (${sub.reportType}) — ${errMsg}`,
          messageEn: `Scheduled job failed: ${sub.name} (${sub.reportType}) — ${errMsg}`,
        });
      } catch { /* operator alert is best-effort — never mask the original failure */ }
      const [run] = await db.insert(reportRuns).values({
        tenantId: sub.tenantId, subscriptionId: Number(sub.id), name: sub.name, reportType: sub.reportType,
        frequency: sub.frequency, status: 'failed', recipientsCount: 0, summary: {}, error: errMsg,
      }).returning({ id: reportRuns.id });
      await db.update(reportSubscriptions).set({ lastRunAt: new Date(), nextRunAt: this.nextRunDate(sub.frequency) }).where(eq(reportSubscriptions.id, sub.id));
      return { run_id: Number(run!.id), subscription_id: Number(sub.id), name: sub.name, report_type: sub.reportType, status: 'failed', delivered: 0, error: errMsg };
    }
  }

  // Cron-callable sweep: run every active subscription that is due (never run yet, or next_run_at has passed).
  async runDue(user: JwtUser) {
    const db = this.db;
    const now = Date.now();
    const subs = await db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.tenantId, user.tenantId!), eq(reportSubscriptions.isActive, true)));
    const due = subs.filter((s: any) => !s.lastRunAt || (s.nextRunAt && new Date(s.nextRunAt).getTime() <= now));
    const runs: any[] = [];
    for (const sub of due) runs.push(await this.executeSubscription(sub, user));
    await this.schedHeartbeat?.beat('bi_scheduler', 'runDue', { due: due.length });
    return { due: due.length, ran_count: runs.length, delivered: runs.reduce((a, r) => a + (r.delivered ?? 0), 0), runs };
  }

  // Run one subscription on demand (ignores the schedule) — the "Run now" button.
  async runSubscriptionNow(id: number, user: JwtUser) {
    const db = this.db;
    const [sub] = await db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.id, id), eq(reportSubscriptions.tenantId, user.tenantId!)));
    if (!sub) throw new NotFoundException({ code: 'SUB_NOT_FOUND', message: 'Subscription not found', messageTh: 'ไม่พบการสมัครรับรายงาน' });
    return this.executeSubscription(sub, user);
  }

  async listRuns(user: JwtUser, limit = 100) {
    const db = this.db;
    const rows = await db.select().from(reportRuns)
      .where(eq(reportRuns.tenantId, user.tenantId!))
      .orderBy(desc(reportRuns.ranAt)).limit(limit);
    return { runs: rows.map((r: any) => ({ id: Number(r.id), subscription_id: r.subscriptionId != null ? Number(r.subscriptionId) : null, name: r.name, report_type: r.reportType, frequency: r.frequency, status: r.status, recipients_count: Number(r.recipientsCount ?? 0), error: r.error, ran_at: r.ranAt })) };
  }

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

  private nextRunDate(frequency: string): Date {
    const d = new Date();
    if (frequency === 'daily')   d.setDate(d.getDate() + 1);
    if (frequency === 'weekly')  d.setDate(d.getDate() + 7);
    if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
    return d;
  }

  private fmtSub(s: any) {
    return {
      id: Number(s.id), name: s.name, report_type: s.reportType,
      frequency: s.frequency, filters: s.filters, recipients: s.recipients,
      is_active: s.isActive, next_run_at: s.nextRunAt, created_by: s.createdBy,
    };
  }
}

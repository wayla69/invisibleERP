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
import { n, fx } from '../../database/queries';
import { TtlCache } from '../../common/ttl-cache';
import { MessagingService } from '../messaging/messaging.service';
import { CollectionsService } from '../finance/collections.service';
import { EamService } from '../eam/eam.service';
import { LedgerService } from '../ledger/ledger.service';
import { LeasesService } from '../leases/leases.service';
import { RevRecService } from '../revenue/revrec.service';
import { JobQueueService } from '../jobs/job-queue.service';
import { JobWorkerService, type JobContext } from '../jobs/job-worker.service';

// Job type for offloading a due report/action subscription to the background worker.
export const REPORT_SUBSCRIPTION_JOB = 'report_subscription';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;
const round4 = (x: number) => Math.round((Number(x) || 0) * 10000) / 10000;

// Catalog of report types a subscription may schedule. Each key maps to a generator below; the catalog
// drives both create-time validation and the report-type picker in the builder UI.
const REPORT_TYPES: Record<string, { label: string; labelEn: string }> = {
  kpi_board:      { label: 'สรุป KPI', labelEn: 'KPI board' },
  sales_cube:     { label: 'ยอดขายตามช่วงเวลา', labelEn: 'Sales cube' },
  finance_trend:  { label: 'แนวโน้มกำไร-ขาดทุน', labelEn: 'Finance (P&L) trend' },
  pipeline_trend: { label: 'แนวโน้มไปป์ไลน์', labelEn: 'Pipeline trend' },
  // An "action" job that rides the scheduler: each run executes the AR dunning sweep and reports a summary.
  // Create a `daily` subscription of this type to dun overdue customers automatically (idempotent per run).
  ar_collections_dunning: { label: 'ทวงถามหนี้อัตโนมัติ', labelEn: 'Automated AR dunning' },
  // Likewise: each run raises preventive-maintenance work orders for every due PM schedule (idempotent).
  eam_pm_generate: { label: 'สร้างใบสั่งงานซ่อมตามแผน (PM)', labelEn: 'Generate due preventive maintenance' },
  // Likewise: each run posts every due recurring/template journal as a Draft JE (maker-checker, idempotent).
  gl_recurring_journals: { label: 'ลงรายการบัญชีตั้งเวลาอัตโนมัติ', labelEn: 'Post due recurring journals' },
  // Likewise: each run amortizes one period of every due prepaid schedule (Dr expense / Cr 1280, idempotent).
  gl_prepaid_amortize: { label: 'ตัดจ่ายค่าใช้จ่ายล่วงหน้า', labelEn: 'Amortize due prepaid expenses' },
  // Likewise: each run posts one period of every due lease (interest + payment + ROU depreciation, idempotent).
  lease_periodic_run: { label: 'ลงรายการสัญญาเช่าประจำงวด', labelEn: 'Post due lease periods' },
  // Likewise: each run recognizes every due TFRS-15 revenue schedule through the current period (idempotent).
  rev_rec_recognize: { label: 'รับรู้รายได้ตามสัญญา (TFRS 15)', labelEn: 'Recognize due revenue schedules' },
  // Data-retention purge of DEAD ephemeral security rows only (never financial/audit/PII — statutory hold).
  data_retention_purge: { label: 'ล้างข้อมูลชั่วคราวที่หมดอายุ (นโยบายเก็บข้อมูล)', labelEn: 'Purge expired ephemeral security rows' },
};
const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;

@Injectable()
export class BiService implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly messaging: MessagingService,
    // Optional so a partially-wired test harness can construct BiService without the finance graph;
    // the full app always provides it (FinanceModule), enabling the scheduled ar_collections_dunning job.
    @Optional() private readonly collections?: CollectionsService,
    @Optional() private readonly eam?: EamService,
    @Optional() private readonly ledger?: LedgerService,
    @Optional() private readonly leases?: LeasesService,
    @Optional() private readonly revrec?: RevRecService,
    @Optional() private readonly jobs?: JobQueueService,
    @Optional() private readonly worker?: JobWorkerService,
  ) {}

  // Register the background handler that runs one due subscription (report or heavy action job) off the
  // request path. The worker claims jobs with FOR UPDATE SKIP LOCKED + retry/backoff; runInTenantContext
  // (set by the worker) scopes the handler to the job's tenant, so we reconstruct a minimal principal here.
  onModuleInit(): void {
    this.worker?.register(REPORT_SUBSCRIPTION_JOB, async (payload: { subscriptionId: number }, ctx: JobContext) => {
      const db = this.db as any;
      const [sub] = await db.select().from(reportSubscriptions).where(eq(reportSubscriptions.id, Number(payload.subscriptionId))).limit(1);
      if (!sub) return { skipped: 'subscription not found' };
      const user = { username: ctx.actor ?? 'system:scheduler', role: ctx.bypass ? 'Admin' : 'Sales', tenantId: ctx.tenantId ?? sub.tenantId, permissions: [], customerName: null } as unknown as JwtUser;
      return this.executeSubscription(sub, user);
    });
  }

  // Async scheduler: enqueue each DUE subscription as a background job (returns immediately) instead of
  // running them inline. Heavy action jobs (dunning, recurring GL, lease/rev-rec runs) then execute on the
  // worker with retry/backoff, off the cron request path. Falls back to inline runDue if the queue is absent.
  async runDueAsync(user: JwtUser) {
    if (!this.jobs) return { ...(await this.runDue(user)), mode: 'inline (queue unavailable)' };
    const db = this.db as any;
    const now = Date.now();
    const subs = await db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.tenantId, user.tenantId!), eq(reportSubscriptions.isActive, true)));
    const due = subs.filter((s: any) => !s.lastRunAt || (s.nextRunAt && new Date(s.nextRunAt).getTime() <= now));
    const enqueued: number[] = [];
    for (const sub of due) {
      const jobId = await this.jobs.enqueue({ jobType: REPORT_SUBSCRIPTION_JOB, payload: { subscriptionId: Number(sub.id) }, tenantId: user.tenantId ?? null, actor: user.username, bypass: user.role === 'Admin' });
      enqueued.push(jobId);
    }
    return { due: due.length, enqueued: enqueued.length, job_ids: enqueued, mode: 'queued' };
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
    const db = this.db as any;
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
        mtd: round2(n(mtdSales.total)), mtd_orders: Number(mtdSales.count),
        ytd: round2(n(ytdSales.total)),
        avg_order_mtd: Number(mtdSales.count) > 0 ? round2(n(mtdSales.total) / Number(mtdSales.count)) : 0,
      },
      receivables: {
        open_ar: round2(n(openAr.total)),
        overdue_ar: round2(n(overdueAr.total)),
        overdue_count: Number(overdueAr.count),
      },
      payables: { open_ap: round2(n(openAp.total)) },
      pipeline: {
        open_value: round2(n(pipeline.total)),
        weighted_value: round2(n(pipeline.weighted)),
        open_count: Number(pipeline.count),
      },
    };
  }

  // ── Sales Cube ─────────────────────────────────────────────────────────────
  // Breakdown by period (day | week | month) with optional group_by (channel | none)

  salesCube(dto: { period?: 'day' | 'week' | 'month'; start_date?: string; end_date?: string; months?: number }, user: JwtUser) {
    return this.cache.wrap(this.cacheKey('salesCube', user.tenantId!, dto), this.cacheTtlMs, () => this.salesCubeUncached(dto, user));
  }
  private async salesCubeUncached(dto: { period?: 'day' | 'week' | 'month'; start_date?: string; end_date?: string; months?: number }, user: JwtUser) {
    const db = this.db as any;
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
    const db = this.db as any;
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
    const db = this.db as any;
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
    const db = this.db as any;
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
    const db = this.db as any;
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

    return { date, snapshot: row };
  }

  async getSnapshots(dto: { start_date?: string; end_date?: string; days?: number }, user: JwtUser) {
    const db = this.db as any;
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

  async createSubscription(dto: { name: string; report_type: string; frequency: string; filters?: object; recipients?: object[] }, user: JwtUser) {
    const db = this.db as any;
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
    const db = this.db as any;
    const rows = await db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.tenantId, user.tenantId!), eq(reportSubscriptions.isActive, true)))
      .orderBy(desc(reportSubscriptions.createdAt));
    return { subscriptions: rows.map((s: any) => this.fmtSub(s)), count: rows.length };
  }

  async deleteSubscription(id: number, user: JwtUser) {
    const db = this.db as any;
    await db.update(reportSubscriptions).set({ isActive: false })
      .where(and(eq(reportSubscriptions.id, id), eq(reportSubscriptions.tenantId, user.tenantId!)));
    return { deleted: id };
  }

  // ── Scheduled-report execution engine ──────────────────────────────────────
  // Generate the payload + a one-line summary (TH/EN) for a report type. Reuses the live aggregations above.
  private async generateReport(reportType: string, filters: any, user: JwtUser): Promise<{ data: any; summary: string; summaryTh: string }> {
    const f = filters ?? {};
    if (reportType === 'kpi_board') {
      const k = await this.kpiBoard(user);
      return { data: k, summary: `MTD sales ${k.sales.mtd}, open AR ${k.receivables.open_ar}, open AP ${k.payables.open_ap}, pipeline ${k.pipeline.open_value}`, summaryTh: `ยอดขายเดือนนี้ ${k.sales.mtd} · ลูกหนี้คงค้าง ${k.receivables.open_ar} · เจ้าหนี้คงค้าง ${k.payables.open_ap}` };
    }
    if (reportType === 'sales_cube') {
      const c = await this.salesCube({ period: f.period, months: f.months, start_date: f.start_date, end_date: f.end_date }, user);
      return { data: c, summary: `Sales ${c.totals.total_sales} across ${c.rows.length} ${c.period_type}(s), ${c.totals.total_orders} orders`, summaryTh: `ยอดขายรวม ${c.totals.total_sales} · ${c.totals.total_orders} ออเดอร์` };
    }
    if (reportType === 'finance_trend') {
      const t = await this.financeTrend({ months: f.months, ledger_code: f.ledger_code }, user);
      const last = t.trend[t.trend.length - 1];
      return { data: t, summary: last ? `Latest ${last.period}: revenue ${last.revenue}, gross profit ${last.gross_profit} (${last.margin_pct}%)` : 'No posted GL in range', summaryTh: last ? `งวดล่าสุด ${last.period}: รายได้ ${last.revenue} · กำไรขั้นต้น ${last.gross_profit}` : 'ไม่มีรายการบัญชีในช่วงนี้' };
    }
    if (reportType === 'pipeline_trend') {
      const p = await this.pipelineTrend({ months: f.months }, user);
      const last = p.trend[p.trend.length - 1];
      return { data: p, summary: last ? `Latest ${last.month}: ${last.open} open (${last.open_value}), win rate ${last.win_rate_pct}%` : 'No pipeline in range', summaryTh: last ? `เดือนล่าสุด ${last.month}: เปิดอยู่ ${last.open} รายการ` : 'ไม่มีไปป์ไลน์ในช่วงนี้' };
    }
    if (reportType === 'ar_collections_dunning') {
      if (!this.collections) throw new BadRequestException({ code: 'COLLECTIONS_UNAVAILABLE', message: 'Collections service not available', messageTh: 'ระบบติดตามหนี้ไม่พร้อมใช้งาน' });
      const r = await this.collections.runDunningSweep(user); // idempotent: re-runs the same day advance nothing
      return { data: r, summary: `Dunning sweep: advanced ${r.advanced} of ${r.scanned} overdue invoices`, summaryTh: `ทวงถามอัตโนมัติ: เลื่อนขั้น ${r.advanced} จาก ${r.scanned} รายการค้างชำระ` };
    }
    if (reportType === 'eam_pm_generate') {
      if (!this.eam) throw new BadRequestException({ code: 'EAM_UNAVAILABLE', message: 'EAM service not available', messageTh: 'ระบบบำรุงรักษาไม่พร้อมใช้งาน' });
      const r = await this.eam.runPmDue(user); // idempotent: a schedule with an open WO is skipped
      return { data: r, summary: `PM generation: raised ${r.generated} of ${r.scanned} schedules`, summaryTh: `สร้างใบสั่งงานซ่อมตามแผน: ${r.generated} จาก ${r.scanned} แผน` };
    }
    if (reportType === 'gl_recurring_journals') {
      if (!this.ledger) throw new BadRequestException({ code: 'LEDGER_UNAVAILABLE', message: 'Ledger service not available', messageTh: 'ระบบบัญชีแยกประเภทไม่พร้อมใช้งาน' });
      const r = await this.ledger.runDueRecurring(user); // idempotent: next_run_date advanced + ux_je_idem
      return { data: r, summary: `Recurring journals: posted ${r.posted} of ${r.scanned} due templates`, summaryTh: `ลงรายการบัญชีตั้งเวลา: ${r.posted} จาก ${r.scanned} แม่แบบ` };
    }
    if (reportType === 'gl_prepaid_amortize') {
      if (!this.ledger) throw new BadRequestException({ code: 'LEDGER_UNAVAILABLE', message: 'Ledger service not available', messageTh: 'ระบบบัญชีแยกประเภทไม่พร้อมใช้งาน' });
      const r = await this.ledger.runDuePrepaid(user); // idempotent per (schedule, period)
      return { data: r, summary: `Prepaid amortization: posted ${r.posted} of ${r.scanned} due schedules`, summaryTh: `ตัดจ่ายค่าใช้จ่ายล่วงหน้า: ${r.posted} จาก ${r.scanned} รายการ` };
    }
    if (reportType === 'lease_periodic_run') {
      if (!this.leases) throw new BadRequestException({ code: 'LEASES_UNAVAILABLE', message: 'Lease service not available', messageTh: 'ระบบสัญญาเช่าไม่พร้อมใช้งาน' });
      const r = await this.leases.runDueLeases(user); // idempotent per (lease, period)
      return { data: r, summary: `Lease run: posted ${r.posted} of ${r.scanned} due leases`, summaryTh: `ลงรายการสัญญาเช่า: ${r.posted} จาก ${r.scanned} สัญญา` };
    }
    if (reportType === 'rev_rec_recognize') {
      if (!this.revrec) throw new BadRequestException({ code: 'REVREC_UNAVAILABLE', message: 'Revenue recognition service not available', messageTh: 'ระบบรับรู้รายได้ไม่พร้อมใช้งาน' });
      // Recognize every TFRS-15 schedule due through the current period for the caller's tenant. Idempotent:
      // an already-recognized schedule is skipped (the REVREC JE is alreadyPosted-guarded).
      const period = new Date().toISOString().slice(0, 7); // YYYY-MM
      const r = await this.revrec.recognize({ period }, user, user.tenantId ?? null);
      return { data: r, summary: `Revenue recognition ${period}: recognized ${r.recognized_count} schedule(s), total ${r.total_recognized}`, summaryTh: `รับรู้รายได้งวด ${period}: ${r.recognized_count} รายการ รวม ${r.total_recognized}` };
    }
    if (reportType === 'data_retention_purge') {
      // Delete ONLY dead ephemeral security rows (auth-global, no statutory value once expired). This
      // NEVER touches financial / audit / transactional / PII tables — those are under statutory legal
      // hold (see docs/ops/data-retention-policy.md). Idempotent. refresh_tokens are kept until EXPIRED
      // (not merely rotated) so reuse-detection still works within a token's life.
      const db = this.db as any;
      const rows = (res: any): number => (res?.rows?.length ?? (Array.isArray(res) ? res.length : 0));
      const a = await db.execute(sql`DELETE FROM revoked_tokens WHERE expires_at < now() RETURNING 1 AS one`);
      const b = await db.execute(sql`DELETE FROM refresh_tokens WHERE expires_at < now() RETURNING 1 AS one`);
      const c = await db.execute(sql`DELETE FROM sso_login_state WHERE expires_at < now() RETURNING 1 AS one`);
      const d = await db.execute(sql`DELETE FROM member_otps WHERE consumed_at IS NOT NULL OR expires_at < now() RETURNING 1 AS one`);
      const purged = { revoked_tokens: rows(a), refresh_tokens: rows(b), sso_login_state: rows(c), member_otps: rows(d) };
      const total = purged.revoked_tokens + purged.refresh_tokens + purged.sso_login_state + purged.member_otps;
      return { data: purged, summary: `Retention purge: removed ${total} expired ephemeral security rows (financial/audit data untouched)`, summaryTh: `ล้างข้อมูลชั่วคราวที่หมดอายุ ${total} รายการ (ไม่แตะข้อมูลการเงิน/ออดิต)` };
    }
    throw new BadRequestException({ code: 'BAD_REPORT_TYPE', message: `Unknown report type '${reportType}'`, messageTh: 'ไม่รู้จักประเภทรายงานนี้' });
  }

  // Execute one subscription: generate → deliver (email recipients + in-app notification) → log a run →
  // advance the schedule. Delivery is best-effort; the run is always recorded.
  private async executeSubscription(sub: any, user: JwtUser) {
    const db = this.db as any;
    try {
      const report = await this.generateReport(sub.reportType, sub.filters, user);
      const recipients = Array.isArray(sub.recipients) ? sub.recipients : [];
      let delivered = 0;
      for (const r of recipients) {
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
      return { run_id: Number(run.id), subscription_id: Number(sub.id), name: sub.name, report_type: sub.reportType, status: 'success', delivered, summary: report.summary };
    } catch (e: any) {
      const [run] = await db.insert(reportRuns).values({
        tenantId: sub.tenantId, subscriptionId: Number(sub.id), name: sub.name, reportType: sub.reportType,
        frequency: sub.frequency, status: 'failed', recipientsCount: 0, summary: {}, error: String(e?.message ?? e),
      }).returning({ id: reportRuns.id });
      await db.update(reportSubscriptions).set({ lastRunAt: new Date(), nextRunAt: this.nextRunDate(sub.frequency) }).where(eq(reportSubscriptions.id, sub.id));
      return { run_id: Number(run.id), subscription_id: Number(sub.id), name: sub.name, report_type: sub.reportType, status: 'failed', delivered: 0, error: String(e?.message ?? e) };
    }
  }

  // Cron-callable sweep: run every active subscription that is due (never run yet, or next_run_at has passed).
  async runDue(user: JwtUser) {
    const db = this.db as any;
    const now = Date.now();
    const subs = await db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.tenantId, user.tenantId!), eq(reportSubscriptions.isActive, true)));
    const due = subs.filter((s: any) => !s.lastRunAt || (s.nextRunAt && new Date(s.nextRunAt).getTime() <= now));
    const runs: any[] = [];
    for (const sub of due) runs.push(await this.executeSubscription(sub, user));
    return { due: due.length, ran_count: runs.length, delivered: runs.reduce((a, r) => a + (r.delivered ?? 0), 0), runs };
  }

  // Run one subscription on demand (ignores the schedule) — the "Run now" button.
  async runSubscriptionNow(id: number, user: JwtUser) {
    const db = this.db as any;
    const [sub] = await db.select().from(reportSubscriptions)
      .where(and(eq(reportSubscriptions.id, id), eq(reportSubscriptions.tenantId, user.tenantId!)));
    if (!sub) throw new NotFoundException({ code: 'SUB_NOT_FOUND', message: 'Subscription not found', messageTh: 'ไม่พบการสมัครรับรายงาน' });
    return this.executeSubscription(sub, user);
  }

  async listRuns(user: JwtUser, limit = 100) {
    const db = this.db as any;
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

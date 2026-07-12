import { Inject, Injectable, Optional, BadRequestException } from '@nestjs/common';
import { eq, and, sql, gte, lte, inArray, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { workflowInstances, purchaseRequests, alertEvents } from '../../database/schema';
import { journalEntries, journalLines } from '../../database/schema/ledger';
import { arInvoices } from '../../database/schema/finance';
import { branchStock } from '../../database/schema/portal';
// HR-9 (docs/42, HR-09) — workforce-analytics read models over the HCM spine.
import { employees } from '../../database/schema/payroll';
import { leaveBalances } from '../../database/schema/hcm';
import { hrDepartments, hrPositions, hrAssignments } from '../../database/schema/hcm-org';
import { employeeLifecycle } from '../../database/schema/hcm-lifecycle';
import { payGrades } from '../../database/schema/hcm-comp';
import { CASH_ACCOUNTS } from '../ledger/ledger-constants';
import { n } from '../../database/queries';
import { cdpConfigured, pushToCdp } from '../../common/cdp-sync';
import { activeKeyId, needsRotation, encrypt, decrypt } from '../../common/crypto';
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
import { CrmAccountHealthService } from '../crm/account-health/crm-account-health.module';
import { CrmService } from '../crm/crm.service';
import { NpsService } from '../nps/nps.service';
import { MembershipService } from '../loyalty/membership.service';
import { JourneysService } from '../journeys/journeys.service';
import { BudgetService } from '../budget/budget.service';
import { ProcurementService } from '../procurement/procurement.service';
import { ThreeWayMatchService } from '../match/three-way-match.service';
import { BillingService } from '../billing/billing.service';
import { PdpaService } from '../pdpa/pdpa.service';
import { GovernanceService } from '../governance/governance.service';
import { TaxJobsService } from '../tax/tax-jobs.service';
import { HcmLeaveService } from '../hcm/hcm-leave.service';
import { FluxService } from '../flux/flux.service';
import { RevDisclosureService } from '../revrec-disclosure/rev-disclosure.service';
import { MarketingAutomationService } from '../marketing/marketing-automation.service';
import { VouchersService } from '../campaigns/vouchers.service';
import { FoodCostService } from '../menu/food-cost.service';
import type { JwtUser } from '../../common/decorators';
import type { BiReportGenerator, BiReportSource } from './report-registry';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// Report generation (docs/38 §3 bi pilot, extraction PR-2). generateReport + its ~50 report-type branches
// and the exec_scorecard composite moved VERBATIM out of bi.service.ts behind the facade: BiService keeps a
// private generateReport delegator (used by executeSubscription/reportTypes), so the public API and the
// BiService constructor (a positional contract — the goldenmaster harness constructs it by position) are
// byte-identical. The cached read core (kpiBoard/salesCube/financeTrend/pipelineTrend) STAYS on BiService;
// branches that need it receive it through the BiReadPort callback interface (BiService passes `this`) —
// structural typing, no forwardRef cycle.
export interface BiReadPort {
  kpiBoard(user: JwtUser): Promise<any>;
  salesCube(dto: { period?: 'day' | 'week' | 'month'; start_date?: string; end_date?: string; months?: number }, user: JwtUser): Promise<any>;
  financeTrend(dto: { months?: number; ledger_code?: string }, user: JwtUser): Promise<any>;
  pipelineTrend(dto: { months?: number }, user: JwtUser): Promise<any>;
}

@Injectable()
export class BiGenerateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    // The same @Optional wiring the branches had on BiService — a partial harness still constructs.
    @Optional() private readonly collections?: CollectionsService,
    @Optional() private readonly financeMetrics?: FinanceMetricsService,
    @Optional() private readonly eam?: EamService,
    @Optional() private readonly assets?: AssetsService,
    @Optional() private readonly ledger?: LedgerService,
    @Optional() private readonly leases?: LeasesService,
    @Optional() private readonly scheduledChanges?: ScheduledChangesService,
    @Optional() private readonly revrec?: RevRecService,
    @Optional() private readonly projects?: ProjectsService,
    @Optional() private readonly retention?: RetentionService,
    @Optional() private readonly realestate?: RealEstateService,
    @Optional() private readonly crm?: CrmPipelineService,
    @Optional() private readonly crmMembers?: CrmService,
    @Optional() private readonly nps?: NpsService,
    @Optional() private readonly membership?: MembershipService,
    @Optional() private readonly journeys?: JourneysService,
    @Optional() private readonly budget?: BudgetService,
    @Optional() private readonly procurement?: ProcurementService,
    @Optional() private readonly match?: ThreeWayMatchService,
    @Optional() private readonly billing?: BillingService,
    @Optional() private readonly pdpa?: PdpaService,
    @Optional() private readonly governance?: GovernanceService,
    @Optional() private readonly taxJobs?: TaxJobsService,
    // HR-2 (docs/42) — supplies the hr_leave_accrual scheduled action job. @Optional so a partial harness constructs.
    @Optional() private readonly hcmLeave?: HcmLeaveService,
    // CLS-01 (GL-25) — supplies the flux_analysis report. Appended at the END to preserve the positional
    // constructor contract the goldenmaster harness relies on. @Optional so a partial harness constructs.
    @Optional() private readonly flux?: FluxService,
    // REV-27 (Track D Wave 4) — supplies the contract_liability_rollforward + rpo_backlog disclosure reports.
    // Appended at the END to preserve the positional constructor contract the goldenmaster harness relies on.
    @Optional() private readonly revDisclosure?: RevDisclosureService,
    // G4 (docs/45) — supply the marketing_roi report. Appended at the END (positional contract, as above).
    @Optional() private readonly marketingAuto?: MarketingAutomationService,
    @Optional() private readonly vouchers?: VouchersService,
    @Optional() private readonly foodCost?: FoodCostService,
    // CRM-15 (CRM-08) — supplies the crm_account_health snapshot action job. Appended at the END to preserve
    // the positional constructor contract the goldenmaster harness relies on. @Optional so a partial harness constructs.
    @Optional() private readonly crmHealth?: CrmAccountHealthService,
  ) {}

  // docs/46 Phase 1 — module-owned generators, filled at boot by BiReportRegistrarService (see
  // report-registry.ts). Consulted BEFORE the legacy if-chain below, so a migrated report type has exactly
  // one home; new report types register here from their owning module instead of growing this file (the
  // check-service-size ratchet enforces it).
  private readonly registered = new Map<string, BiReportGenerator>();
  registerReports(source: BiReportSource) {
    for (const g of source.biReports()) this.registered.set(g.type, g);
  }

  async generateReport(reportType: string, filters: any, user: JwtUser, reads: BiReadPort): Promise<{ data: any; summary: string; summaryTh: string }> {
    const f = filters ?? {};
    const provider = this.registered.get(reportType);
    if (provider) return provider.generate(f, user);
    if (reportType === 'kpi_board') {
      const k = await reads.kpiBoard(user);
      return { data: k, summary: `MTD sales ${k.sales.mtd}, open AR ${k.receivables.open_ar}, open AP ${k.payables.open_ap}, pipeline ${k.pipeline.open_value}`, summaryTh: `ยอดขายเดือนนี้ ${k.sales.mtd} · ลูกหนี้คงค้าง ${k.receivables.open_ar} · เจ้าหนี้คงค้าง ${k.payables.open_ap}` };
    }
    if (reportType === 'sales_cube') {
      const c = await reads.salesCube({ period: f.period, months: f.months, start_date: f.start_date, end_date: f.end_date }, user);
      return { data: c, summary: `Sales ${c.totals.total_sales} across ${c.rows.length} ${c.period_type}(s), ${c.totals.total_orders} orders`, summaryTh: `ยอดขายรวม ${c.totals.total_sales} · ${c.totals.total_orders} ออเดอร์` };
    }
    if (reportType === 'finance_trend') {
      const t = await reads.financeTrend({ months: f.months, ledger_code: f.ledger_code }, user);
      const last = t.trend[t.trend.length - 1];
      return { data: t, summary: last ? `Latest ${last.period}: revenue ${last.revenue}, gross profit ${last.gross_profit} (${last.margin_pct}%)` : 'No posted GL in range', summaryTh: last ? `งวดล่าสุด ${last.period}: รายได้ ${last.revenue} · กำไรขั้นต้น ${last.gross_profit}` : 'ไม่มีรายการบัญชีในช่วงนี้' };
    }
    if (reportType === 'pipeline_trend') {
      const p = await reads.pipelineTrend({ months: f.months }, user);
      const last = p.trend[p.trend.length - 1];
      return { data: p, summary: last ? `Latest ${last.month}: ${last.open} open (${last.open_value}), win rate ${last.win_rate_pct}%` : 'No pipeline in range', summaryTh: last ? `เดือนล่าสุด ${last.month}: เปิดอยู่ ${last.open} รายการ` : 'ไม่มีไปป์ไลน์ในช่วงนี้' };
    }
    if (reportType === 'ar_collections_dunning') {
      if (!this.collections) throw new BadRequestException({ code: 'COLLECTIONS_UNAVAILABLE', message: 'Collections service not available', messageTh: 'ระบบติดตามหนี้ไม่พร้อมใช้งาน' });
      const r = await this.collections.runDunningSweep(user); // idempotent: re-runs the same day advance nothing
      return { data: r, summary: `Dunning sweep: advanced ${r.advanced} of ${r.scanned} overdue invoices`, summaryTh: `ทวงถามอัตโนมัติ: เลื่อนขั้น ${r.advanced} จาก ${r.scanned} รายการค้างชำระ` };
    }
    if (reportType === 'journey_runner') {
      if (!this.journeys) throw new BadRequestException({ code: 'JOURNEYS_UNAVAILABLE', message: 'Journeys service not available', messageTh: 'ระบบเจอร์นีย์ไม่พร้อมใช้งาน' });
      const r = await this.journeys.runDueAll(user); // at-most-once per step: each enrollment-step is claimed before delivery
      return { data: r, summary: `Journeys: sent ${r.sent}, skipped ${r.skipped} across ${r.tenants_processed} tenant(s)`, summaryTh: `เจอร์นีย์: ส่ง ${r.sent} ข้าม ${r.skipped} ใน ${r.tenants_processed} ร้าน` };
    }
    if (reportType === 'crm_profile_refresh') {
      if (!this.crmMembers) throw new BadRequestException({ code: 'CRM_UNAVAILABLE', message: 'CRM service not available', messageTh: 'ระบบ CRM ไม่พร้อมใช้งาน' });
      const r = await this.crmMembers.refreshAllProfiles(user); // idempotent: a pure profile upsert per member
      return { data: r, summary: `RFM refresh: profiled ${r.profiled} members, ${r.segment_changes} segment change(s)`, summaryTh: `รีเฟรช RFM: ${r.profiled} สมาชิก เปลี่ยนกลุ่ม ${r.segment_changes} ราย` };
    }
    if (reportType === 'crm_followup_digest') {
      if (!this.crm) throw new BadRequestException({ code: 'CRM_UNAVAILABLE', message: 'CRM pipeline service not available', messageTh: 'ระบบไปป์ไลน์ CRM ไม่พร้อมใช้งาน' });
      const r = await this.crm.runFollowUpSweep(user); // read-only: fires lead.stagnant + a rail notification
      return { data: r, summary: `Follow-up digest: ${r.total} item(s) — ${r.sla_breaches} SLA-breached lead(s), ${r.overdue_activities} overdue task(s), ${r.rotting_deals} rotting deal(s)`, summaryTh: `สรุปการติดตาม: ${r.total} รายการ — ลีดเกิน SLA ${r.sla_breaches} · งานเลยกำหนด ${r.overdue_activities} · ดีลค้าง ${r.rotting_deals}` };
    }
    if (reportType === 'cdp_export_sync') {
      if (!this.crmMembers) throw new BadRequestException({ code: 'CRM_UNAVAILABLE', message: 'CRM service not available', messageTh: 'ระบบ CRM ไม่พร้อมใช้งาน' });
      const target = cdpConfigured() ? 'cdp' : 'mock';
      // Push the whole member base in batches (idempotent full snapshot on member_code); consent flags ride
      // each row so the CDP honours opt-outs. A batch failure stops the run and is reported in the summary.
      const BATCH = 500; let offset = 0, pushed = 0, total = 0, ok = true;
      for (let i = 0; i < 200; i++) { // safety cap: 200 batches (100k members)
        const exp: any = await this.crmMembers.exportForCdp(user, { limit: BATCH, offset });
        if (exp?.error) throw new BadRequestException(exp.error);
        total = exp.total;
        if (!exp.members?.length) break;
        const r = await pushToCdp({ tenant_id: exp.tenant_id, batch: i, offset, count: exp.members.length, total, members: exp.members });
        if (!r.ok) { ok = false; break; }
        pushed += exp.members.length;
        offset += exp.members.length;
        if (exp.members.length < BATCH) break;
      }
      return { data: { pushed, total, target, ok }, summary: `CDP sync: pushed ${pushed}/${total} members to ${target}${ok ? '' : ' (stopped on error)'}`, summaryTh: `ซิงก์ CDP: ส่ง ${pushed}/${total} สมาชิกไปยัง ${target}${ok ? '' : ' (หยุดเพราะข้อผิดพลาด)'}` };
    }
    if (reportType === 'ap_automatch_rerun') {
      if (!this.match) throw new BadRequestException({ code: 'MATCH_UNAVAILABLE', message: 'Match service not available', messageTh: 'ระบบจับคู่ 3 ทางไม่พร้อมใช้งาน' });
      const r = await this.match.rematchBlocked(user); // idempotent: re-verdicts from current PO/GR state; overrides untouched
      return { data: r, summary: `Auto re-match: released ${r.released} of ${r.swept} blocked invoice(s)`, summaryTh: `จับคู่ซ้ำอัตโนมัติ: ปลดล็อก ${r.released} จาก ${r.swept} ใบที่ถูกระงับ` };
    }
    if (reportType === 'eam_pm_generate') {
      if (!this.eam) throw new BadRequestException({ code: 'EAM_UNAVAILABLE', message: 'EAM service not available', messageTh: 'ระบบบำรุงรักษาไม่พร้อมใช้งาน' });
      const r = await this.eam.runPmDue(user); // idempotent: a schedule with an open WO is skipped
      return { data: r, summary: `PM generation: raised ${r.generated} of ${r.scanned} schedules`, summaryTh: `สร้างใบสั่งงานซ่อมตามแผน: ${r.generated} จาก ${r.scanned} แผน` };
    }
    if (reportType === 'asset_audit') {
      if (!this.assets) throw new BadRequestException({ code: 'ASSETS_UNAVAILABLE', message: 'Assets service not available', messageTh: 'ระบบทรัพย์สินไม่พร้อมใช้งาน' });
      const r = await this.assets.auditReport(user, { limit: f.limit });
      return { data: r, summary: `Asset audits: ${r.totals.audits}, missing ${r.totals.missing}, misplaced ${r.totals.misplaced}; ${r.totals.pending_custody} custody request(s) pending`, summaryTh: `ตรวจนับทรัพย์สิน ${r.totals.audits} ครั้ง · ขาดหาย ${r.totals.missing} · ผิดตำแหน่ง ${r.totals.misplaced} · รออนุมัติย้าย ${r.totals.pending_custody}` };
    }
    if (reportType === 'asset_verification_exceptions') {
      if (!this.assets) throw new BadRequestException({ code: 'ASSETS_UNAVAILABLE', message: 'Assets service not available', messageTh: 'ระบบทรัพย์สินไม่พร้อมใช้งาน' });
      const r = await this.assets.unverifiedAssets(user, { days: f.days });
      return { data: r, summary: `${r.count} of ${r.total_active} active assets not verified in ${r.days} days`, summaryTh: `${r.count} จาก ${r.total_active} สินทรัพย์ไม่ได้ตรวจสอบเกิน ${r.days} วัน` };
    }
    if (reportType === 'line_daily_digest') {
      const db = this.db;
      const tenantCond = user.tenantId != null ? eq(workflowInstances.tenantId, user.tenantId) : sql`true`;
      const [wf] = await db.select({ c: sql<number>`count(*)` }).from(workflowInstances).where(and(eq(workflowInstances.status, 'pending'), tenantCond));
      const [pr] = await db.select({ c: sql<number>`count(*)` }).from(purchaseRequests).where(eq(purchaseRequests.status, 'Pending'));
      const [ae] = await db.select({ c: sql<number>`count(*)` }).from(alertEvents).where(and(user.tenantId != null ? eq(alertEvents.tenantId, user.tenantId) : sql`true`, sql`${alertEvents.firedAt} > now() - interval '24 hours'`));
      // LP-3 (docs/31) — the wider KPI catalog (Asia/Bangkok business day). Computed ONCE per tenant here;
      // delivery filters per recipient by effective permissions (see runSubscription). Read-only aggregates.
      const bkkNow = new Date(Date.now() + 7 * 3600_000);
      const today = bkkNow.toISOString().slice(0, 10);
      const yesterday = new Date(bkkNow.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
      const [sy] = await db.select({ v: sql<string>`coalesce(sum(${arInvoices.amount}), 0)` }).from(arInvoices)
        .where(and(user.tenantId != null ? eq(arInvoices.tenantId, user.tenantId) : sql`true`, eq(arInvoices.invoiceDate, yesterday)));
      const [ao] = await db.select({ v: sql<string>`coalesce(sum(${arInvoices.amount} - coalesce(${arInvoices.paidAmount}, 0)), 0)` }).from(arInvoices)
        .where(and(user.tenantId != null ? eq(arInvoices.tenantId, user.tenantId) : sql`true`, sql`${arInvoices.status} <> 'Paid'`, sql`${arInvoices.dueDate} < ${today}`));
      const [cp] = await db.select({ v: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)` })
        .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
        .where(and(eq(journalEntries.status, 'Posted'), inArray(journalLines.accountCode, [...CASH_ACCOUNTS]),
          user.tenantId != null ? eq(journalEntries.tenantId, user.tenantId) : sql`true`));
      const [ls] = await db.select({ c: sql<number>`count(*)` }).from(branchStock)
        .where(and(user.tenantId != null ? eq(branchStock.tenantId, user.tenantId) : sql`true`,
          sql`${branchStock.reorderPoint} > 0 and ${branchStock.onHand} <= ${branchStock.reorderPoint}`));
      const data = {
        pending_approvals: Number(wf?.c ?? 0), open_prs: Number(pr?.c ?? 0), alerts_24h: Number(ae?.c ?? 0),
        sales_yesterday: Number(sy?.v ?? 0), cash_position: Number(cp?.v ?? 0), ar_overdue: Number(ao?.v ?? 0), low_stock: Number(ls?.c ?? 0),
      };
      return {
        data,
        summary: `Daily digest: ${data.pending_approvals} pending approvals · ${data.open_prs} open PRs · ${data.alerts_24h} alerts (24h)`,
        summaryTh: `สรุปเช้านี้: รออนุมัติ ${data.pending_approvals} รายการ · PR ค้าง ${data.open_prs} · แจ้งเตือนใน 24 ชม. ${data.alerts_24h}`,
      };
    }
    if (reportType === 'low_stock_reorder_alert') {
      // D1 — read-only: reuse feature-C's low-stock computation (items.min_stock vs summed inv_balances)
      // so the alert matches exactly what `reorder`/เปิด PR เติมของ will order. Delivery + one-tap button
      // are formatted per recipient in executeSubscription; here we just carry the list + a count.
      if (!this.procurement) throw new BadRequestException({ code: 'PROCUREMENT_UNAVAILABLE', message: 'Procurement service not available', messageTh: 'ระบบจัดซื้อไม่พร้อมใช้งาน' });
      const { items: low, count } = await this.procurement.lowStock(user, { limit: 20 });
      return {
        data: { count, items: low },
        summary: `Low-stock reorder alert: ${count} item(s) at/below reorder point`,
        summaryTh: count ? `สินค้าใกล้หมด ${count} รายการ (ถึง/ต่ำกว่าจุดสั่งซื้อ)` : 'สินค้าใกล้หมด: ไม่มี',
      };
    }
    if (reportType === 'purchase_spend') {
      // D3 — read-only: reuse ProcurementService.purchaseSpend (total + top vendors + most-bought items).
      if (!this.procurement) throw new BadRequestException({ code: 'PROCUREMENT_UNAVAILABLE', message: 'Procurement service not available', messageTh: 'ระบบจัดซื้อไม่พร้อมใช้งาน' });
      const sp = await this.procurement.purchaseSpend(user, { period: f.period || undefined });
      const topV = sp.by_vendor[0];
      return {
        data: sp,
        summary: `Purchase spend ${sp.period}: ${sp.total.toLocaleString()} across ${sp.po_count} PO(s)${topV ? `; top vendor ${topV.vendor} ${topV.total.toLocaleString()}` : ''}`,
        summaryTh: `ยอดซื้อเดือน ${sp.period}: ฿${sp.total.toLocaleString('th-TH', { maximumFractionDigits: 2 })} · ${sp.po_count} ใบสั่งซื้อ${topV ? ` · ผู้ขายสูงสุด ${topV.vendor}` : ''}`,
      };
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
    if (reportType === 'gl_allocation_run') {
      if (!this.ledger) throw new BadRequestException({ code: 'LEDGER_UNAVAILABLE', message: 'Ledger service not available', messageTh: 'ระบบบัญชีแยกประเภทไม่พร้อมใช้งาน' });
      const r = await this.ledger.runDueAllocations(user); // idempotent per period: next_run_date advanced + ux_je_idem
      return { data: r, summary: `Allocation cycles: posted ${r.posted} of ${r.scanned} due cycles`, summaryTh: `ปันส่วนต้นทุน: ${r.posted} จาก ${r.scanned} รอบ` };
    }
    if (reportType === 'lease_periodic_run') {
      if (!this.leases) throw new BadRequestException({ code: 'LEASES_UNAVAILABLE', message: 'Lease service not available', messageTh: 'ระบบสัญญาเช่าไม่พร้อมใช้งาน' });
      const r = await this.leases.runDueLeases(user); // idempotent per (lease, period)
      return { data: r, summary: `Lease run: posted ${r.posted} of ${r.scanned} due leases`, summaryTh: `ลงรายการสัญญาเช่า: ${r.posted} จาก ${r.scanned} สัญญา` };
    }
    if (reportType === 'hr_leave_accrual') {
      if (!this.hcmLeave) throw new BadRequestException({ code: 'HCM_LEAVE_UNAVAILABLE', message: 'HCM leave service not available', messageTh: 'ระบบสะสมวันลาไม่พร้อมใช้งาน' });
      const r = await this.hcmLeave.runAccrual(user, f.period || undefined); // idempotent per (tenant, period)
      return { data: r, summary: `Leave accrual ${r.period}: accrued ${r.accrued} day(s) across ${r.employees_count} employee(s)${r.already ? ' (already run)' : ''}`, summaryTh: `สะสมวันลา ${r.period}: ${r.accrued} วัน · ${r.employees_count} คน${r.already ? ' (รันแล้ว)' : ''}` };
    }
    // ── HR-9 (docs/42 HCM depth, Wave 3, HR-09) — workforce analytics ─────────────────────────────────────
    // Read-only aggregations over the HCM spine. Tenant-scoped (explicit tenant filter + RLS): a null-tenant
    // (platform/HQ) session aggregates across companies, a tenant session sees only its own rows. All idempotent.
    if (reportType === 'hr_headcount_trend') {
      const db = this.db;
      const tid = user.tenantId ?? null;
      const empTenant = tid != null ? eq(employees.tenantId, tid) : sql`true`;
      const asgTenant = tid != null ? eq(hrAssignments.tenantId, tid) : sql`true`;
      // Total active headcount on the payroll identity.
      const [tot] = await db.select({ c: sql<string>`count(*)` }).from(employees).where(and(empTenant, eq(employees.active, true)));
      // Headcount by DEPARTMENT via CURRENT org assignments (end_date IS NULL) → position → department.
      const byDeptRows = await db.select({ department: hrDepartments.name, headcount: sql<string>`count(distinct ${hrAssignments.empCode})` })
        .from(hrAssignments)
        .innerJoin(hrPositions, eq(hrAssignments.positionId, hrPositions.id))
        .innerJoin(hrDepartments, eq(hrPositions.deptId, hrDepartments.id))
        .where(and(asgTenant, isNull(hrAssignments.endDate)))
        .groupBy(hrDepartments.name)
        .orderBy(sql`count(distinct ${hrAssignments.empCode}) desc`);
      // Headcount by POSITION (title) via the same current assignments.
      const byPosRows = await db.select({ position: hrPositions.title, headcount: sql<string>`count(distinct ${hrAssignments.empCode})` })
        .from(hrAssignments)
        .innerJoin(hrPositions, eq(hrAssignments.positionId, hrPositions.id))
        .where(and(asgTenant, isNull(hrAssignments.endDate)))
        .groupBy(hrPositions.title)
        .orderBy(sql`count(distinct ${hrAssignments.empCode}) desc`);
      // Hire-cohort trend (the "by period" dimension): active employees grouped by hire month (start_date).
      const byMonthRows = await db.select({ month: sql<string>`to_char(${employees.startDate}, 'YYYY-MM')`, hires: sql<string>`count(*)` })
        .from(employees)
        .where(and(empTenant, eq(employees.active, true), sql`${employees.startDate} is not null`))
        .groupBy(sql`to_char(${employees.startDate}, 'YYYY-MM')`)
        .orderBy(sql`to_char(${employees.startDate}, 'YYYY-MM')`);
      const total_active = Number(tot?.c ?? 0);
      const by_department = byDeptRows.map((r: any) => ({ department: r.department ?? '—', headcount: Number(r.headcount) }));
      const by_position = byPosRows.map((r: any) => ({ position: r.position ?? '—', headcount: Number(r.headcount) }));
      const by_hire_month = byMonthRows.map((r: any) => ({ month: r.month, hires: Number(r.hires) }));
      const data = { as_of: new Date().toISOString().slice(0, 10), total_active, by_department, by_position, by_hire_month };
      return { data, summary: `Headcount: ${total_active} active across ${by_department.length} department(s), ${by_position.length} position(s)`, summaryTh: `กำลังคน: ${total_active} คน · ${by_department.length} แผนก · ${by_position.length} ตำแหน่ง` };
    }
    if (reportType === 'hr_turnover') {
      const db = this.db;
      const tid = user.tenantId ?? null;
      const empTenant = tid != null ? eq(employees.tenantId, tid) : sql`true`;
      const lcTenant = tid != null ? eq(employeeLifecycle.tenantId, tid) : sql`true`;
      const months = Number(f.window_months) > 0 ? Number(f.window_months) : 12;
      const winStart = new Date(); winStart.setMonth(winStart.getMonth() - months);
      // Separations = completed OFFBOARDING lifecycles (HR-5 joiner-mover-leaver) within the window.
      const [sep] = await db.select({ c: sql<string>`count(*)` }).from(employeeLifecycle)
        .where(and(lcTenant, eq(employeeLifecycle.kind, 'offboarding'), eq(employeeLifecycle.status, 'complete'),
          sql`${employeeLifecycle.completedAt} is not null`, gte(employeeLifecycle.completedAt, winStart)));
      const [act] = await db.select({ c: sql<string>`count(*)` }).from(employees).where(and(empTenant, eq(employees.active, true)));
      const [inact] = await db.select({ c: sql<string>`count(*)` }).from(employees).where(and(empTenant, eq(employees.active, false)));
      const separations = Number(sep?.c ?? 0);
      const active = Number(act?.c ?? 0);
      const inactive = Number(inact?.c ?? 0);
      // Average headcount over the window ≈ current active + those who left during it (a beginning-of-window proxy).
      const avg_headcount = active + separations;
      const turnover_pct = avg_headcount > 0 ? round2((separations / avg_headcount) * 100) : 0;
      const data = { as_of: new Date().toISOString().slice(0, 10), window_months: months, window_start: winStart.toISOString().slice(0, 10), separations, active_headcount: active, inactive_headcount: inactive, avg_headcount, turnover_pct };
      return { data, summary: `Turnover (${months}m): ${turnover_pct}% — ${separations} separation(s) vs ${avg_headcount} avg headcount`, summaryTh: `อัตราการลาออก (${months} เดือน): ${turnover_pct}% — ลาออก ${separations} จากกำลังคนเฉลี่ย ${avg_headcount}` };
    }
    if (reportType === 'hr_tenure_distribution') {
      const db = this.db;
      const tid = user.tenantId ?? null;
      const empTenant = tid != null ? eq(employees.tenantId, tid) : sql`true`;
      const rows = await db.select({ empCode: employees.empCode, startDate: employees.startDate })
        .from(employees).where(and(empTenant, eq(employees.active, true)));
      // Tenure buckets computed in-app from start_date (no SQL date math; the row set is small).
      const BUCKETS = [
        { key: '<1y', maxMonths: 12 }, { key: '1-3y', maxMonths: 36 }, { key: '3-5y', maxMonths: 60 },
        { key: '5-10y', maxMonths: 120 }, { key: '10y+', maxMonths: Infinity },
      ] as const;
      const counts: Record<string, number> = { '<1y': 0, '1-3y': 0, '3-5y': 0, '5-10y': 0, '10y+': 0, 'unknown': 0 };
      const now = Date.now();
      let sumMonths = 0, known = 0;
      for (const r of rows) {
        if (!r.startDate) { counts['unknown']!++; continue; }
        const months = Math.max(0, (now - new Date(String(r.startDate) + 'T00:00:00Z').getTime()) / (1000 * 60 * 60 * 24 * 30.4375));
        sumMonths += months; known++;
        const b = BUCKETS.find((x) => months < x.maxMonths) ?? BUCKETS[BUCKETS.length - 1]!;
        counts[b.key] = (counts[b.key] ?? 0) + 1;
      }
      const total = rows.length;
      const buckets = [...BUCKETS.map((b) => ({ bucket: b.key, count: counts[b.key] ?? 0 })), { bucket: 'unknown', count: counts['unknown'] ?? 0 }];
      const avg_tenure_months = known > 0 ? round2(sumMonths / known) : 0;
      const data = { as_of: new Date().toISOString().slice(0, 10), total, avg_tenure_months, buckets };
      return { data, summary: `Tenure: ${total} employee(s), avg ${avg_tenure_months} month(s); ${counts['<1y']} under 1y, ${counts['10y+']} over 10y`, summaryTh: `อายุงาน: ${total} คน · เฉลี่ย ${avg_tenure_months} เดือน · ต่ำกว่า 1 ปี ${counts['<1y']} คน` };
    }
    if (reportType === 'hr_comp_ratio') {
      const db = this.db;
      const tid = user.tenantId ?? null;
      const empTenant = tid != null ? eq(employees.tenantId, tid) : sql`true`;
      // Actual salary vs the employee's pay-grade band (HR-6 pay_grades: min/mid/max). Employees whose
      // job_grade has no band are "ungraded" and excluded from the comp-ratio maths (surfaced in the count).
      const [act] = await db.select({ c: sql<string>`count(*)` }).from(employees).where(and(empTenant, eq(employees.active, true)));
      const rows = await db.select({
        empCode: employees.empCode, grade: employees.jobGrade, salary: employees.monthlySalary,
        minSalary: payGrades.minSalary, midSalary: payGrades.midSalary, maxSalary: payGrades.maxSalary,
      }).from(employees)
        .innerJoin(payGrades, and(eq(employees.jobGrade, payGrades.gradeCode), tid != null ? eq(payGrades.tenantId, tid) : sql`true`))
        .where(and(empTenant, eq(employees.active, true)));
      const byGrade: Record<string, { grade: string; headcount: number; min_band: number; midpoint: number; max_band: number; sumRatio: number }> = {};
      const outOfBand: { emp_code: string; grade: string; salary: number; comp_ratio: number; flag: 'below' | 'above' }[] = [];
      let sumRatioAll = 0;
      for (const r of rows) {
        const salary = n(r.salary);
        const min = n(r.minSalary), max = n(r.maxSalary);
        // Midpoint: the band's mid_salary, falling back to (min+max)/2 when a band left mid at 0.
        const mid = n(r.midSalary) > 0 ? n(r.midSalary) : (min + max) / 2;
        const ratio = mid > 0 ? round2(salary / mid) : 0;
        sumRatioAll += ratio;
        const g = String(r.grade);
        byGrade[g] ??= { grade: g, headcount: 0, min_band: min, midpoint: mid, max_band: max, sumRatio: 0 };
        byGrade[g]!.headcount++; byGrade[g]!.sumRatio += ratio;
        if (max > 0 && salary > max) outOfBand.push({ emp_code: String(r.empCode), grade: g, salary, comp_ratio: ratio, flag: 'above' });
        else if (min > 0 && salary < min) outOfBand.push({ emp_code: String(r.empCode), grade: g, salary, comp_ratio: ratio, flag: 'below' });
      }
      const count_rated = rows.length;
      const by_grade = Object.values(byGrade).map((x) => ({ grade: x.grade, headcount: x.headcount, min_band: round2(x.min_band), midpoint: round2(x.midpoint), max_band: round2(x.max_band), avg_comp_ratio: x.headcount > 0 ? round2(x.sumRatio / x.headcount) : 0 }));
      const avg_comp_ratio = count_rated > 0 ? round2(sumRatioAll / count_rated) : 0;
      const ungraded = Math.max(0, Number(act?.c ?? 0) - count_rated);
      const data = { as_of: new Date().toISOString().slice(0, 10), count_rated, ungraded, avg_comp_ratio, employees_out_of_band: outOfBand.length, by_grade, out_of_band: outOfBand };
      return { data, summary: `Comp ratio: ${count_rated} rated, avg ${avg_comp_ratio}, ${outOfBand.length} out-of-band`, summaryTh: `อัตราค่าตอบแทน: ${count_rated} คน · เฉลี่ย ${avg_comp_ratio} · นอกกรอบ ${outOfBand.length} คน` };
    }
    if (reportType === 'hr_leave_liability') {
      const db = this.db;
      const tid = user.tenantId ?? null;
      const lbTenant = tid != null ? eq(leaveBalances.tenantId, tid) : sql`true`;
      // Accrued-but-untaken days per balance = entitled + accrued + carryover − used − expired (floored at 0),
      // valued at the employee's daily rate (monthly_salary ÷ working days/month, default 22).
      const workingDays = Number(f.working_days) > 0 ? Number(f.working_days) : 22;
      const rows = await db.select({
        empCode: employees.empCode, leaveType: leaveBalances.leaveType, salary: employees.monthlySalary,
        entitled: leaveBalances.entitled, used: leaveBalances.used, accrued: leaveBalances.accrued,
        carryover: leaveBalances.carryover, expired: leaveBalances.expired,
      }).from(leaveBalances)
        .innerJoin(employees, eq(leaveBalances.employeeId, employees.id))
        .where(and(lbTenant, eq(employees.active, true)));
      const byType: Record<string, { leave_type: string; days: number; liability: number }> = {};
      const byEmp: Record<string, { emp_code: string; days: number; liability: number }> = {};
      let total_days = 0, total_liability = 0;
      for (const r of rows) {
        const avail = Math.max(0, n(r.entitled) + n(r.accrued) + n(r.carryover) - n(r.used) - n(r.expired));
        if (avail <= 0) continue;
        const perDay = workingDays > 0 ? n(r.salary) / workingDays : 0;
        const liab = round2(avail * perDay);
        total_days = round2(total_days + avail);
        total_liability = round2(total_liability + liab);
        const lt = String(r.leaveType ?? '—');
        byType[lt] ??= { leave_type: lt, days: 0, liability: 0 };
        byType[lt]!.days = round2(byType[lt]!.days + avail); byType[lt]!.liability = round2(byType[lt]!.liability + liab);
        const ec = String(r.empCode ?? '—');
        byEmp[ec] ??= { emp_code: ec, days: 0, liability: 0 };
        byEmp[ec]!.days = round2(byEmp[ec]!.days + avail); byEmp[ec]!.liability = round2(byEmp[ec]!.liability + liab);
      }
      const by_leave_type = Object.values(byType).sort((a, b) => b.liability - a.liability);
      const by_employee = Object.values(byEmp).sort((a, b) => b.liability - a.liability).slice(0, 50);
      const data = { as_of: new Date().toISOString().slice(0, 10), working_days_per_month: workingDays, total_untaken_days: total_days, total_liability, by_leave_type, by_employee };
      return { data, summary: `Leave liability: ${total_liability} THB over ${total_days} untaken day(s) across ${by_employee.length} employee(s)`, summaryTh: `ภาระวันลาสะสม: ${total_liability} บาท · ${total_days} วันคงค้าง · ${by_employee.length} คน` };
    }
    if (reportType === 'apply_scheduled_master_changes') {
      if (!this.scheduledChanges) throw new BadRequestException({ code: 'SCHEDULED_CHANGES_UNAVAILABLE', message: 'Scheduled-changes service not available', messageTh: 'ระบบตั้งเวลาข้อมูลหลักไม่พร้อมใช้งาน' });
      const r = await this.scheduledChanges.applyDue(user); // idempotent: only `scheduled` rows due today; applied rows skip
      return { data: r, summary: `Date-effective master changes: applied ${r.applied} of ${r.scanned} due (as of ${r.as_of})`, summaryTh: `ปรับข้อมูลหลักตามวันที่มีผล: ${r.applied} จาก ${r.scanned} รายการ (ณ ${r.as_of})` };
    }
    if (reportType === 'retention_release_due') {
      if (!this.retention) throw new BadRequestException({ code: 'RETENTION_UNAVAILABLE', message: 'Retention service not available', messageTh: 'ระบบเงินประกันผลงานไม่พร้อมใช้งาน' });
      const r = await this.retention.runDueReleases(); // idempotent per tranche
      return { data: r, summary: `Retention release: released ${r.released} of ${r.scanned} due tranches (${r.amount})`, summaryTh: `คืนเงินประกันผลงาน: ${r.released} จาก ${r.scanned} งวด (${r.amount})` };
    }
    if (reportType === 're_booking_expire') {
      if (!this.realestate) throw new BadRequestException({ code: 'REALESTATE_UNAVAILABLE', message: 'Real-estate service not available', messageTh: 'ระบบอสังหาฯ ไม่พร้อมใช้งาน' });
      const r = await this.realestate.expireDueBookings(); // frees the unit back to available
      return { data: r, summary: `Booking expiry: expired ${r.expired} of ${r.scanned} lapsed bookings`, summaryTh: `ยกเลิกการจองหมดอายุ: ${r.expired} จาก ${r.scanned} รายการ` };
    }
    if (reportType === 're_installment_overdue') {
      if (!this.realestate) throw new BadRequestException({ code: 'REALESTATE_UNAVAILABLE', message: 'Real-estate service not available', messageTh: 'ระบบอสังหาฯ ไม่พร้อมใช้งาน' });
      const r = await this.realestate.overdueInstallments(); // detective — surfaces the overdue worklist
      return { data: r, summary: `Overdue installments: ${r.overdue} pending (${r.total})`, summaryTh: `งวดผ่อนเกินกำหนด: ${r.overdue} งวด (${r.total})` };
    }
    if (reportType === 'nps_post_purchase') {
      if (!this.nps) throw new BadRequestException({ code: 'NPS_UNAVAILABLE', message: 'NPS service not available', messageTh: 'ระบบ NPS ไม่พร้อมใช้งาน' });
      const r = await this.nps.sendDue(user, Number(f.window_days) > 0 ? Number(f.window_days) : 1); // idempotent per member × sale (unique index)
      return { data: r, summary: `NPS surveys: sent ${r.sent} of ${r.orders} recent paid orders (${r.skipped} skipped/already surveyed)`, summaryTh: `แบบสอบถาม NPS: ส่ง ${r.sent} จาก ${r.orders} บิลล่าสุด` };
    }
    if (reportType === 'membership_revenue_recognize') {
      if (!this.membership) throw new BadRequestException({ code: 'MEMBERSHIP_UNAVAILABLE', message: 'Membership service not available', messageTh: 'ระบบสมาชิก VIP ไม่พร้อมใช้งาน' });
      const r = await this.membership.recognizeDue(user); // idempotent per (membership, month) via the JE dedup
      return { data: r, summary: `VIP recognition: posted ${r.posted} month(s), ฿${r.amount} across ${r.scanned} membership(s)`, summaryTh: `รับรู้รายได้ VIP: ${r.posted} งวด ฿${r.amount}` };
    }
    if (reportType === 'tax_wht_cert_batch') {
      if (!this.taxJobs) throw new BadRequestException({ code: 'TAX_JOBS_UNAVAILABLE', message: 'Tax jobs service not available', messageTh: 'ระบบงานภาษีไม่พร้อมใช้งาน' });
      const r = await this.taxJobs.runWhtCertBatch(user, f.month ? Number(f.month) : undefined, f.year ? Number(f.year) : undefined); // idempotent: skips already-certificated payments
      return { data: r, summary: `WHT certificates ${r.period}: issued ${r.issued} of ${r.scanned} (${r.skipped} skipped)`, summaryTh: `หนังสือรับรองหัก ณ ที่จ่าย ${r.period}: ออก ${r.issued} จาก ${r.scanned} รายการ (ข้าม ${r.skipped})` };
    }
    if (reportType === 'tax_pp30_draft' || reportType === 'tax_pnd_draft') {
      if (!this.taxJobs) throw new BadRequestException({ code: 'TAX_JOBS_UNAVAILABLE', message: 'Tax jobs service not available', messageTh: 'ระบบงานภาษีไม่พร้อมใช้งาน' });
      const type = reportType === 'tax_pp30_draft' ? 'PP30' : (f.pnd_type || 'PND53');
      const r = await this.taxJobs.runFilingDraft(user, type, f.month ? Number(f.month) : undefined, f.year ? Number(f.year) : undefined); // idempotent per (tenant,type,period)
      return { data: r, summary: `Draft filing ${type} ${r.period}: status ${r.status}${r.already_filed ? ' (already filed)' : ''}`, summaryTh: `จัดทำแบบ ${type} ${r.period}: สถานะ ${r.status}` };
    }
    if (reportType === 'tax_remittance_reminder') {
      if (!this.taxJobs) throw new BadRequestException({ code: 'TAX_JOBS_UNAVAILABLE', message: 'Tax jobs service not available', messageTh: 'ระบบงานภาษีไม่พร้อมใช้งาน' });
      const r = await this.taxJobs.remittanceReminder(user, f.month ? Number(f.month) : undefined, f.year ? Number(f.year) : undefined);
      return { data: r, summary: `Remittance ${r.period}: PP30 net VAT ฿${r.pp30.net_vat_payable} (due ${r.pp30.deadline}); WHT ฿${r.pnd.wht_withheld} (due ${r.pnd.deadline}), un-certificated ฿${r.pnd.uncertificated_wht}`, summaryTh: `นำส่งภาษี ${r.period}: VAT สุทธิ ฿${r.pp30.net_vat_payable} (ครบกำหนด ${r.pp30.deadline}); หัก ณ ที่จ่าย ฿${r.pnd.wht_withheld} (ครบกำหนด ${r.pnd.deadline})` };
    }
    if (reportType === 'etax_submission_retry') {
      if (!this.taxJobs) throw new BadRequestException({ code: 'TAX_JOBS_UNAVAILABLE', message: 'Tax jobs service not available', messageTh: 'ระบบงานภาษีไม่พร้อมใช้งาน' });
      const r = await this.taxJobs.runEtaxSubmissionRetry(user, f.limit ? Number(f.limit) : undefined); // idempotent: only the latest non-Accepted attempt per doc_no is retried
      return { data: r, summary: `e-Tax retry: ${r.succeeded} of ${r.scanned} succeeded (${r.failed} still failed)`, summaryTh: `ลองส่ง e-Tax ซ้ำ: สำเร็จ ${r.succeeded} จาก ${r.scanned} (ยังล้มเหลว ${r.failed})` };
    }
    if (reportType === 'governance_readiness') {
      if (!this.governance) throw new BadRequestException({ code: 'GOVERNANCE_UNAVAILABLE', message: 'Governance service not available', messageTh: 'ระบบธรรมาภิบาลไม่พร้อมใช้งาน' });
      const r = await this.governance.readiness(user, f.policy_version || '1.0'); // read-only snapshot
      const summary = r.ready
        ? `Governance ready: acknowledgement ${r.ethics.coverage_pct}%, oversight current, ${r.hotline.open_cases} open case(s)`
        : `Governance attention: ${r.alerts.join(' · ')}`;
      return { data: r, summary, summaryTh: r.ready ? `ธรรมาภิบาลพร้อม: ยอมรับจรรยาบรรณ ${r.ethics.coverage_pct}%` : `ต้องดำเนินการ: ${r.alerts.length} รายการ` };
    }
    if (reportType === 'rev_rec_recognize') {
      if (!this.revrec) throw new BadRequestException({ code: 'REVREC_UNAVAILABLE', message: 'Revenue recognition service not available', messageTh: 'ระบบรับรู้รายได้ไม่พร้อมใช้งาน' });
      // Recognize every TFRS-15 schedule due through the current period for the caller's tenant. Idempotent:
      // an already-recognized schedule is skipped (the REVREC JE is alreadyPosted-guarded).
      const period = new Date().toISOString().slice(0, 7); // YYYY-MM
      const r = await this.revrec.recognize({ period }, user, user.tenantId ?? null);
      return { data: r, summary: `Revenue recognition ${period}: recognized ${r.recognized_count} schedule(s), total ${r.total_recognized}`, summaryTh: `รับรู้รายได้งวด ${period}: ${r.recognized_count} รายการ รวม ${r.total_recognized}` };
    }
    if (reportType === 'contract_liability_rollforward') {
      if (!this.revDisclosure) throw new BadRequestException({ code: 'REVDISCLOSURE_UNAVAILABLE', message: 'Revenue disclosure service not available', messageTh: 'ระบบเปิดเผยข้อมูลรายได้ไม่พร้อมใช้งาน' });
      // TFRS 15 §120(b) contract-liability rollforward for the caller's tenant. Read-only; ties to GL by construction.
      let period = f.period as string | undefined;
      if (!period || !/^\d{4}-\d{2}$/.test(period)) period = new Date().toISOString().slice(0, 7);
      const r = await this.revDisclosure.contractLiabilityRollforward(period, user, user.tenantId ?? null);
      const cl = r.contract_liability;
      return { data: r, summary: `Contract-liability rollforward ${period}: opening ${cl.opening} + billings ${cl.billings} − recognized ${cl.recognized} = closing ${cl.closing} (GL ${cl.gl_closing}, ${r.reconciled ? 'reconciled' : 'OUT OF BALANCE'})`, summaryTh: `กระทบยอดหนี้สินตามสัญญา ${period}: ยกมา ${cl.opening} + วางบิล ${cl.billings} − รับรู้ ${cl.recognized} = ยกไป ${cl.closing} (${r.reconciled ? 'กระทบยอดตรง' : 'ไม่ตรง'})` };
    }
    if (reportType === 'rpo_backlog') {
      if (!this.revDisclosure) throw new BadRequestException({ code: 'REVDISCLOSURE_UNAVAILABLE', message: 'Revenue disclosure service not available', messageTh: 'ระบบเปิดเผยข้อมูลรายได้ไม่พร้อมใช้งาน' });
      // TFRS 15 §120(a) remaining performance obligation (backlog) for the caller's tenant. Read-only.
      const r = await this.revDisclosure.rpo(user, { asOf: f.period, explicitTenantId: user.tenantId ?? null });
      return { data: r, summary: `RPO / backlog: ${r.total_rpo} across ${r.count} contract(s) — ${r.within_12m} within 12m, ${r.beyond_12m} beyond`, summaryTh: `ภาระที่ยังไม่ปฏิบัติ (Backlog): ${r.total_rpo} จาก ${r.count} สัญญา — ภายใน 12 เดือน ${r.within_12m} · เกินกว่านั้น ${r.beyond_12m}` };
    }
    if (reportType === 'data_retention_purge') {
      // Delete ONLY dead ephemeral security rows (auth-global, no statutory value once expired). This
      // NEVER touches financial / audit / transactional / PII tables — those are under statutory legal
      // hold (see docs/ops/data-retention-policy.md). Idempotent. refresh_tokens are kept until EXPIRED
      // (not merely rotated) so reuse-detection still works within a token's life.
      const db = this.db;
      const rows = (res: any): number => (res?.rows?.length ?? (Array.isArray(res) ? res.length : 0));
      const a = await db.execute(sql`DELETE FROM revoked_tokens WHERE expires_at < now() RETURNING 1 AS one`);
      const b = await db.execute(sql`DELETE FROM refresh_tokens WHERE expires_at < now() RETURNING 1 AS one`);
      const c = await db.execute(sql`DELETE FROM sso_login_state WHERE expires_at < now() RETURNING 1 AS one`);
      const d = await db.execute(sql`DELETE FROM member_otps WHERE consumed_at IS NOT NULL OR expires_at < now() RETURNING 1 AS one`);
      const purged = { revoked_tokens: rows(a), refresh_tokens: rows(b), sso_login_state: rows(c), member_otps: rows(d) };
      const total = purged.revoked_tokens + purged.refresh_tokens + purged.sso_login_state + purged.member_otps;
      return { data: purged, summary: `Retention purge: removed ${total} expired ephemeral security rows (financial/audit data untouched)`, summaryTh: `ล้างข้อมูลชั่วคราวที่หมดอายุ ${total} รายการ (ไม่แตะข้อมูลการเงิน/ออดิต)` };
    }
    if (reportType === 'project_evm') {
      if (!this.projects) throw new BadRequestException({ code: 'PROJECTS_UNAVAILABLE', message: 'Projects service not available', messageTh: 'ระบบโครงการไม่พร้อมใช้งาน' });
      const r = await this.projects.portfolioEvm(user);
      return { data: r, summary: `Portfolio EVM: ${r.count} project(s), CPI ${r.totals.cpi ?? '—'}, ${r.at_risk.length} at risk`, summaryTh: `EVM พอร์ตโครงการ: ${r.count} โครงการ · CPI ${r.totals.cpi ?? '—'} · เสี่ยง ${r.at_risk.length}` };
    }
    if (reportType === 'crm_win_loss') {
      if (!this.crm) throw new BadRequestException({ code: 'CRM_UNAVAILABLE', message: 'CRM pipeline service not available', messageTh: 'ระบบไปป์ไลน์ไม่พร้อมใช้งาน' });
      const r = await this.crm.winLoss(user, { months: f.months });
      return { data: r, summary: `Win/loss: win rate ${r.summary.win_rate}, won ${r.summary.won_amount}, lost ${r.summary.lost_amount}, ${r.loss_reasons.length} loss reason(s)`, summaryTh: `Win/Loss: อัตราชนะ ${r.summary.win_rate} · ชนะ ${r.summary.won_amount} · แพ้ ${r.summary.lost_amount}` };
    }
    // CRM-5 analytics that answer "why" — funnel + velocity, source ROI, forecast categories. Read-only.
    if (reportType === 'crm_funnel') {
      if (!this.crm) throw new BadRequestException({ code: 'CRM_UNAVAILABLE', message: 'CRM pipeline service not available', messageTh: 'ระบบไปป์ไลน์ไม่พร้อมใช้งาน' });
      const r = await this.crm.funnel(user, { months: f.months });
      const slowest = r.velocity[0];
      return { data: r, summary: `Funnel (${r.window_months}m): ${r.funnel[0]?.count ?? 0} lead(s) → ${r.funnel[3]?.count ?? 0} won (${r.overall_conversion_pct}% end-to-end); avg cycle ${r.avg_sales_cycle_days}d${slowest ? `; slowest stage ${slowest.stage} ${slowest.avg_days_in_stage}d` : ''}`, summaryTh: `กรวยการขาย (${r.window_months} เดือน): ${r.funnel[0]?.count ?? 0} lead → ชนะ ${r.funnel[3]?.count ?? 0} (${r.overall_conversion_pct}%) · รอบขายเฉลี่ย ${r.avg_sales_cycle_days} วัน` };
    }
    if (reportType === 'crm_source_roi') {
      if (!this.crm) throw new BadRequestException({ code: 'CRM_UNAVAILABLE', message: 'CRM pipeline service not available', messageTh: 'ระบบไปป์ไลน์ไม่พร้อมใช้งาน' });
      const r = await this.crm.sourceRoi(user, { months: f.months });
      const top = r.sources[0];
      return { data: r, summary: `Source ROI (${r.window_months}m): ${r.sources.length} source(s), won ${r.total_won}${top ? `; top ${top.source} ${top.won_amount} (${top.win_rate_pct}% win)` : ''}`, summaryTh: `ROI ตามแหล่งที่มา (${r.window_months} เดือน): ${r.sources.length} แหล่ง · ยอดชนะ ${r.total_won}${top ? ` · สูงสุด ${top.source} ${top.won_amount}` : ''}` };
    }
    if (reportType === 'crm_forecast') {
      if (!this.crm) throw new BadRequestException({ code: 'CRM_UNAVAILABLE', message: 'CRM pipeline service not available', messageTh: 'ระบบไปป์ไลน์ไม่พร้อมใช้งาน' });
      const r = await this.crm.forecast(user, { months: f.months, quotas: f.quotas });
      return { data: r, summary: `Forecast: commit ${r.categories.commit.amount}, best-case ${r.categories.best_case.amount}, pipeline ${r.categories.pipeline.amount}; weighted forecast ${r.forecast_amount}; ${r.quota_attainment.length} owner(s)`, summaryTh: `พยากรณ์: commit ${r.categories.commit.amount} · best-case ${r.categories.best_case.amount} · pipeline ${r.categories.pipeline.amount} · ถ่วงน้ำหนัก ${r.forecast_amount}` };
    }
    if (reportType === 'budget_variance') {
      if (!this.budget) throw new BadRequestException({ code: 'BUDGET_UNAVAILABLE', message: 'Budget service not available', messageTh: 'ระบบงบประมาณไม่พร้อมใช้งาน' });
      const fy = Number(f.fiscal_year) || new Date().getFullYear();
      const r = await this.budget.budgetVsActual({ fiscal_year: fy, period: f.period, cost_center: f.cost_center });
      return { data: r, summary: `Budget ${fy}: net variance ${r.rollup.net.variance} (${r.rollup.net.favorable ? 'favorable' : 'unfavorable'}); ${r.review.requires_review_count} item(s) need review`, summaryTh: `งบประมาณ ${fy}: ผลต่างสุทธิ ${r.rollup.net.variance} · ต้องทบทวน ${r.review.requires_review_count} รายการ` };
    }
    if (reportType === 'marketing_roi') return this.marketingRoi(user, f);
    if (reportType === 'flux_analysis') {
      if (!this.flux) throw new BadRequestException({ code: 'FLUX_UNAVAILABLE', message: 'Flux analysis service not available', messageTh: 'ระบบวิเคราะห์ผลต่างไม่พร้อมใช้งาน' });
      // Default the period to the prior month (last full close period) if the schedule didn't pin one.
      let period = f.period as string | undefined;
      if (!period || !/^\d{4}-\d{2}$/.test(period)) {
        const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1);
        period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      }
      const r = await this.flux.generate({ period, basis: f.basis, comparative: f.comparative, threshold_abs: f.threshold_abs, threshold_pct: f.threshold_pct }, user);
      const a = r.analysis;
      return { data: r, summary: `Flux ${a.period} (${a.basis} vs ${a.comparative_period}): ${a.breached_count} line(s) breach threshold${a.breached_count ? ' — explanation required before sign-off' : ''}`, summaryTh: `วิเคราะห์ผลต่าง ${a.period} (${a.basis} เทียบ ${a.comparative_period}): เกินเกณฑ์ ${a.breached_count} รายการ${a.breached_count ? ' — ต้องอธิบายก่อนลงนามรับรอง' : ''}` };
    }
    if (reportType === 'supplier_scorecard') {
      if (!this.procurement) throw new BadRequestException({ code: 'PROCUREMENT_UNAVAILABLE', message: 'Procurement service not available', messageTh: 'ระบบจัดซื้อไม่พร้อมใช้งาน' });
      const r = await this.procurement.listScorecards({ period: f.period, limit: f.limit }, user);
      return { data: r, summary: `Suppliers: ${r.count} scored, avg ${r.avg_score}, ${r.underperformers} underperformer(s) (<70)`, summaryTh: `ผู้ขาย: ให้คะแนน ${r.count} ราย · เฉลี่ย ${r.avg_score} · ต่ำกว่าเกณฑ์ ${r.underperformers} ราย` };
    }
    if (reportType === 'project_health_capture') {
      if (!this.projects) throw new BadRequestException({ code: 'PROJECTS_UNAVAILABLE', message: 'Projects service not available', messageTh: 'ระบบโครงการไม่พร้อมใช้งาน' });
      const r = await this.projects.captureAllHealth(user); // idempotent per (project, date)
      return { data: r, summary: `Project health: captured ${r.captured} of ${r.scanned} project(s) for ${r.as_of}`, summaryTh: `บันทึกสุขภาพโครงการ: ${r.captured} จาก ${r.scanned} โครงการ` };
    }
    if (reportType === 'crm_account_health') {
      if (!this.crmHealth) throw new BadRequestException({ code: 'CRM_UNAVAILABLE', message: 'CRM service not available', messageTh: 'ระบบ CRM ไม่พร้อมใช้งาน' });
      const r = await this.crmHealth.captureAllHealth(user); // idempotent per (account, date)
      return { data: r, summary: `Account health: captured ${r.captured} of ${r.scanned} account(s) for ${r.as_of}`, summaryTh: `บันทึกสุขภาพบัญชีลูกค้า: ${r.captured} จาก ${r.scanned} บัญชี` };
    }
    if (reportType === 'project_governance_pack') {
      if (!this.projects) throw new BadRequestException({ code: 'PROJECTS_UNAVAILABLE', message: 'Projects service not available', messageTh: 'ระบบโครงการไม่พร้อมใช้งาน' });
      const r: any = await this.projects.governancePack(user, { period: filters?.period }); // portfolio scope
      return { data: r, summary: `Governance pack ${r.period}: ${r.count} project(s) — ${r.summary.red} red, ${r.summary.unmitigated_high} unmitigated-high risk(s), ${r.summary.overdue_milestones} overdue milestone(s), ${r.summary.pending_change_orders} pending change order(s)`, summaryTh: `รายงานสถานะ ${r.period}: ${r.count} โครงการ · แดง ${r.summary.red} · เสี่ยงสูงยังไม่รับมือ ${r.summary.unmitigated_high} · หมุดหมายเลยกำหนด ${r.summary.overdue_milestones} · ใบเปลี่ยนแปลงรออนุมัติ ${r.summary.pending_change_orders}` };
    }
    if (reportType === 'exec_scorecard') {
      const r = await this.execScorecard(user, reads);
      return { data: r, summary: `Exec: sales(MTD) ${r.finance.sales_mtd}, margin ${r.finance.margin_pct ?? '—'}%, win rate ${r.crm.win_rate_pct ?? '—'}%, portfolio CPI ${r.projects.cpi ?? '—'}, ${r.supply_chain.blocked_invoices} held invoice(s)`, summaryTh: `ผู้บริหาร: ยอดขายเดือนนี้ ${r.finance.sales_mtd} · มาร์จิน ${r.finance.margin_pct ?? '—'}% · อัตราชนะ ${r.crm.win_rate_pct ?? '—'}% · CPI ${r.projects.cpi ?? '—'}` };
    }
    // docs/35 Phase 6 — schedulable finance packs (wrap the canonical aggregators; summary carries the MD&A headline).
    if (reportType === 'cfo_kpi_pack') {
      if (!this.financeMetrics) throw new BadRequestException({ code: 'FINANCE_METRICS_UNAVAILABLE', message: 'Finance metrics engine not available', messageTh: 'ระบบตัวชี้วัดการเงินไม่พร้อมใช้งาน' });
      const r: any = await this.financeMetrics.pack({}, user);
      const reds = r.kpis.filter((k: any) => k.rag === 'red').length;
      return { data: r, summary: `CFO KPIs (${r.as_of}): ${r.narrative?.headline_en ?? ''} — ${reds} red`, summaryTh: `ตัวชี้วัด CFO (${r.as_of}): ${r.narrative?.headline_th ?? ''}` };
    }
    if (reportType === 'cash_position_pack') {
      if (!this.financeMetrics) throw new BadRequestException({ code: 'FINANCE_METRICS_UNAVAILABLE', message: 'Finance metrics engine not available', messageTh: 'ระบบตัวชี้วัดการเงินไม่พร้อมใช้งาน' });
      const r: any = await this.financeMetrics.cashPosition({ weeks: 13 }, user);
      return { data: r, summary: `Cash ${r.total_cash}; projected close ${r.forecast?.projected_closing_cash}; trough ${r.forecast?.min_balance} at wk+${r.forecast?.min_week}`, summaryTh: `เงินสด ${r.total_cash} · คาดการณ์ปลายช่วง ${r.forecast?.projected_closing_cash} · จุดต่ำสุด ${r.forecast?.min_balance} สัปดาห์ +${r.forecast?.min_week}` };
    }
    if (reportType === 'close_status_pack') {
      if (!this.financeMetrics) throw new BadRequestException({ code: 'FINANCE_METRICS_UNAVAILABLE', message: 'Finance metrics engine not available', messageTh: 'ระบบตัวชี้วัดการเงินไม่พร้อมใช้งาน' });
      const r: any = await this.financeMetrics.closeStatus({}, user);
      return { data: r, summary: `Close ${r.period}: overall ${r.rag?.overall}; tie-out exceptions ${r.tie_out?.exceptions ?? '—'}; days-to-close ${r.days_to_close}`, summaryTh: `ปิดงวด ${r.period}: สถานะ ${r.rag?.overall} · รายการไม่ตรง ${r.tie_out?.exceptions ?? '—'} · จำนวนวันปิดงวด ${r.days_to_close}` };
    }
    if (reportType === 'ai_overage_billing') {
      if (!this.billing) throw new BadRequestException({ code: 'BILLING_UNAVAILABLE', message: 'Billing service not available', messageTh: 'ระบบเรียกเก็บเงินไม่พร้อมใช้งาน' });
      const r = await this.billing.runAiOverageBilling(user, filters?.month); // idempotent per (tenant, month)
      return { data: r, summary: `AI overage billing ${r.month}: charged ${r.processed_count} tenant(s), total ${r.total_amount} THB`, summaryTh: `เรียกเก็บค่า AI ส่วนเกิน ${r.month}: ${r.processed_count} ร้าน รวม ${r.total_amount} บาท` };
    }
    if (reportType === 'usage_overage_billing') {
      if (!this.billing) throw new BadRequestException({ code: 'BILLING_UNAVAILABLE', message: 'Billing service not available', messageTh: 'ระบบเรียกเก็บเงินไม่พร้อมใช้งาน' });
      const r = await this.billing.runUsageOverageBilling(user, filters?.month); // idempotent per (tenant, meter, month)
      return { data: r, summary: `Usage overage billing ${r.month}: charged ${r.processed_count} meter-tenant(s), total ${r.total_amount} THB`, summaryTh: `เรียกเก็บค่าใช้งานส่วนเกิน ${r.month}: ${r.processed_count} รายการ รวม ${r.total_amount} บาท` };
    }
    if (reportType === 'pii_retention_sweep') {
      if (!this.pdpa) throw new BadRequestException({ code: 'PDPA_UNAVAILABLE', message: 'PDPA service not available', messageTh: 'ระบบ PDPA ไม่พร้อมใช้งาน' });
      // Opt-in per tenant (pdpa_retention_policies, enabled=true); idempotent — an already-anonymized member is never a candidate.
      const r = await this.pdpa.runRetentionSweep(user);
      return { data: r, summary: `PII retention sweep: ${r.swept_total} member(s) anonymized across ${r.policies} enabled polic(ies)`, summaryTh: `ลบล้างข้อมูลส่วนบุคคลพ้นระยะเก็บรักษา: ${r.swept_total} ราย จาก ${r.policies} นโยบายที่เปิดใช้` };
    }
    if (reportType === 'key_rotation_sweep') {
      // 4.3 (ITGC-AC-12) — re-encrypt at-rest ciphertext under the ACTIVE key id (common/crypto.ts keyring).
      // INERT with no keyring configured: active kid = legacy '1' and every existing blob is already v1 ⇒
      // needsRotation() is false for every row, so the sweep scans and rotates 0. After ops sets
      // APP_ENC_KEYRING + APP_ENC_ACTIVE_KID, each run re-encrypts up to 500 rows/column (idempotent — the
      // ciphertext's embedded key id is the discriminator; re-runs converge to 0). Plaintext legacy rows are
      // the encrypt-backfill's job (tools db:backfill-encrypt-pii), not rotation's — they are skipped here.
      const db = this.db;
      const targets: { table: string; column: string }[] = [
        { table: 'customer_master', column: 'tax_id' }, { table: 'customer_master', column: 'address' }, { table: 'customer_master', column: 'notes' },
        { table: 'employees', column: 'national_id' }, { table: 'employees', column: 'sso_no' }, { table: 'employees', column: 'bank_account' },
        { table: 'payslips', column: 'national_id' },
        { table: 'vendors', column: 'tax_id' }, { table: 'vendors', column: 'bank_account' },
        { table: 'vendor_bank_change_requests', column: 'bank_account' }, { table: 'vendor_bank_change_requests', column: 'prev_bank_account' },
        { table: 'customer_addresses', column: 'address_line1' }, { table: 'vendor_addresses', column: 'address_line1' },
        { table: 'users', column: 'totp_secret' }, { table: 'webhooks', column: 'secret' },
        { table: 'tenant_identity', column: 'oidc_client_secret_enc' }, { table: 'tenant_messaging_config', column: 'config_enc' },
      ];
      const activeKid = activeKeyId();
      let scanned = 0, rotated = 0;
      const perColumn: { table: string; column: string; scanned: number; rotated: number }[] = [];
      for (const t of targets) {
        // Identifiers come from the compile-time const list above (never user input); values are bound.
        const res: any = await db.execute(sql`SELECT id, ${sql.raw(`"${t.column}"`)} AS val FROM ${sql.raw(`"${t.table}"`)} WHERE ${sql.raw(`"${t.column}"`)} LIKE 'v%:%' LIMIT 500`);
        const rows: any[] = res.rows ?? res;
        let colScanned = 0, colRotated = 0;
        for (const row of rows) {
          colScanned++;
          const val = String(row.val ?? '');
          if (!needsRotation(val)) continue; // already under the active key (or a v-prefixed plaintext false-positive)
          const reenc = encrypt(decrypt(val)); // decrypt via the blob's embedded kid, re-encrypt under the active kid
          await db.execute(sql`UPDATE ${sql.raw(`"${t.table}"`)} SET ${sql.raw(`"${t.column}"`)} = ${reenc} WHERE id = ${row.id}`);
          colRotated++;
        }
        scanned += colScanned; rotated += colRotated;
        if (colScanned) perColumn.push({ table: t.table, column: t.column, scanned: colScanned, rotated: colRotated });
      }
      const data = { active_key_id: activeKid, scanned, rotated, per_column: perColumn };
      return { data, summary: `Key rotation sweep (active kid ${activeKid}): re-encrypted ${rotated} of ${scanned} scanned ciphertext(s)`, summaryTh: `หมุนกุญแจเข้ารหัส (kid ${activeKid}): เข้ารหัสใหม่ ${rotated} จาก ${scanned} รายการ` };
    }
    throw new BadRequestException({ code: 'BAD_REPORT_TYPE', message: `Unknown report type '${reportType}'`, messageTh: 'ไม่รู้จักประเภทรายงานนี้' });
  }

  // G4 (docs/45) — one exec view of marketing spend → lift → margin. HONEST FRAMING (the semantic trap the
  // plan calls out): campaign attribution's redeemedValue is the DISCOUNT GIVEN (marketing cost), never
  // revenue — real revenue comes from the redeemed sales' own totals, margin from their line items joined
  // to the recipe-based food-cost layer (the same source menu-engineering uses), and the organic holdout
  // lift is the incremental-revenue truth. Optional legs degrade to null like execScorecard.
  private async marketingRoi(user: JwtUser, f: any) {
    if (!this.marketingAuto) throw new BadRequestException({ code: 'MARKETING_UNAVAILABLE', message: 'Marketing automation service not available', messageTh: 'ระบบการตลาดอัตโนมัติไม่พร้อมใช้งาน' });
    const mkt = await this.marketingAuto.roiAttribution(user, { days: f.days });

    // margin on the attributed sales via the food-cost layer (only costed items count; coverage is reported)
    let margin: { attributed_margin: number; costed_coverage_pct: number } | null = null;
    if (this.foodCost && mkt.attributed.items.length) {
      const m = await this.foodCost.menuMargins(user).catch(() => null);
      if (m) {
        const costBySku = new Map<string, any>((m.items ?? []).map((i: any) => [String(i.sku), i]));
        let attributedMargin = 0, costedAmount = 0, totalAmount = 0;
        for (const it of mkt.attributed.items) {
          totalAmount = round2(totalAmount + it.amount);
          const cm = costBySku.get(String(it.item_id));
          if (cm && cm.costed) { attributedMargin = round2(attributedMargin + (it.amount - n(cm.cost) * it.qty)); costedAmount = round2(costedAmount + it.amount); }
        }
        margin = { attributed_margin: attributedMargin, costed_coverage_pct: totalAmount > 0 ? round2((costedAmount / totalAmount) * 100) : 0 };
      }
    }

    const vouchers = this.vouchers
      ? await this.vouchers.listCampaigns(user, {}).then((v: any) => {
          const cs = v.campaigns ?? [];
          const redeemed = cs.reduce((a: number, c: any) => a + n(c.redeemed_count), 0);
          // only amount-kind codes have a knowable discount without the sale; percent-kind is counted, not costed
          const est = cs.filter((c: any) => c.kind === 'amount').reduce((a: number, c: any) => a + n(c.value) * n(c.redeemed_count), 0);
          return { campaigns: cs.length, codes_redeemed: redeemed, est_discount_given_amount_kind: round2(est) };
        }).catch(() => null)
      : null;
    const b2b = this.crm ? await this.crm.sourceRoi(user, { months: f.months }).catch(() => null) : null;
    const budget = this.budget && f.fiscal_year
      ? await this.budget.budgetVsActual({ fiscal_year: Number(f.fiscal_year), period: f.period, cost_center: f.cost_center }).catch(() => null)
      : null;

    const spend = round2(mkt.discount_cost + (vouchers?.est_discount_given_amount_kind ?? 0));
    const netMargin = margin ? round2(margin.attributed_margin - mkt.discount_cost) : null;
    const totals = {
      spend, attributed_sales: mkt.attributed.sales_count, attributed_revenue: mkt.attributed.revenue,
      attributed_margin: margin?.attributed_margin ?? null, net_margin_after_discount: netMargin,
      roi_on_spend: netMargin != null && spend > 0 ? round2(netMargin / spend) : null,
      organic_incremental_revenue: mkt.lift?.incremental_revenue ?? null,
      b2b_won: b2b?.total_won ?? null,
    };
    const data = { window_days: mkt.window_days, totals, campaigns: mkt.campaigns, top_campaigns: mkt.top_campaigns, attributed: mkt.attributed, margin, lift: mkt.lift, vouchers, b2b, budget, note: 'spend = ส่วนลดที่ให้จริง (redeemedValue) — ไม่ใช่รายได้; รายได้/กำไรมาจากบิลที่แลกจริง; lift มาจาก holdout baseline' };
    const mg = margin ? `, margin ${margin.attributed_margin} (net ${netMargin})` : '';
    const lf = mkt.lift ? `; organic lift +${mkt.lift.incremental_revenue} (${mkt.lift.campaigns_measured} campaign(s))` : '';
    const bb = b2b ? `; B2B won ${b2b.total_won}` : '';
    return {
      data,
      summary: `Marketing ROI (${mkt.window_days}d): spend ${spend} → ${mkt.attributed.sales_count} attributed sale(s), revenue ${mkt.attributed.revenue}${mg}${lf}${bb}`,
      summaryTh: `ผลตอบแทนการตลาด (${mkt.window_days} วัน): ใช้ส่วนลด ${spend} → บิลที่แลก ${mkt.attributed.sales_count} ใบ รายได้ ${mkt.attributed.revenue}${margin ? ` กำไรขั้นต้น ${margin.attributed_margin} (สุทธิ ${netMargin})` : ''}${mkt.lift ? ` · lift ${mkt.lift.incremental_revenue}` : ''}${b2b ? ` · B2B ชนะ ${b2b.total_won}` : ''}`,
    };
  }

  private async execScorecard(user: JwtUser, reads: BiReadPort) {
    const kpi: any = await reads.kpiBoard(user).catch(() => null);
    const fin: any = await reads.financeTrend({ months: 6 }, user).catch(() => null);
    const finLast = fin?.trend?.[fin.trend.length - 1] ?? null;
    const pipe: any = await reads.pipelineTrend({ months: 6 }, user).catch(() => null);
    const pipeLast = pipe?.trend?.[pipe.trend.length - 1] ?? null;
    const portfolio: any = this.projects ? await this.projects.portfolioEvm(user).catch(() => null) : null;
    const scorecards: any = this.procurement ? await this.procurement.listScorecards({}, user).catch(() => null) : null;
    const holds: any = this.match ? await this.match.listResults({ blocked: true }, user).catch(() => null) : null;
    // docs/35 Phase 1 — pull the finance leg from the canonical KPI engine (single source of truth) when
    // wired; fall back to the legacy trend-derived margin so a partial harness still returns a scorecard.
    const finMetrics: any = this.financeMetrics ? await this.financeMetrics.execFinance(user).catch(() => null) : null;
    return {
      as_of: new Date().toISOString().slice(0, 10),
      finance: {
        sales_mtd: n(kpi?.sales?.mtd), sales_ytd: n(kpi?.sales?.ytd),
        open_ar: n(kpi?.receivables?.open_ar), open_ap: n(kpi?.payables?.open_ap),
        margin_pct: finMetrics ? finMetrics.net_margin_pct : (finLast ? n(finLast.margin_pct) : null),
        gross_profit: finLast ? n(finLast.gross_profit) : null,
        gross_margin_pct: finMetrics?.gross_margin_pct ?? null, current_ratio: finMetrics?.current_ratio ?? null,
        dso: finMetrics?.dso ?? null, operating_cash_flow: finMetrics?.operating_cash_flow ?? null,
        cash_runway_months: finMetrics?.cash_runway_months ?? null,
        kpi_red_flags: finMetrics?.red_flags ?? [],
      },
      crm: {
        open_value: n(kpi?.pipeline?.open_value),
        win_rate_pct: pipeLast ? n(pipeLast.win_rate_pct) : null, open_count: pipeLast ? n(pipeLast.open) : null,
      },
      projects: {
        count: portfolio?.count ?? null, cpi: portfolio?.totals?.cpi ?? null,
        at_risk: portfolio?.at_risk?.length ?? null, over_allocated: portfolio?.capacity?.over_allocated_count ?? null,
      },
      supply_chain: {
        blocked_invoices: n(holds?.blocked), suppliers_scored: scorecards?.count ?? 0,
        supplier_avg_score: scorecards?.avg_score ?? null, underperformers: scorecards?.underperformers ?? 0,
      },
      // The single "what needs attention" rollup — non-zero items the exec should act on.
      attention: {
        held_invoices: n(holds?.blocked),
        at_risk_projects: portfolio?.at_risk?.length ?? 0,
        budget_unfavorable: finLast && n(finLast.margin_pct) < 0,
        supplier_underperformers: scorecards?.underperformers ?? 0,
      },
    };
  }
}

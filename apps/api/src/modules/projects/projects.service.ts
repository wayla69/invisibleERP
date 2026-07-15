import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projects, projectEntries, projectTasks, projectMilestones, projectBaselines, projectTemplates, projectTemplateItems, projectRisks, projectChangeOrders, projectHealthSnapshots, projectCloseReviews, projectBoq, projectBoqLines, projectMaterialRequisitions, employeeAdvances, expenseClaims, expenseRequests, crmOpportunities, customerMaster, timesheets, journalEntries, journalLines, projectResources, resourceCalendar } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { BiLiveService } from '../bi/bi-live.service';
import { CommitmentsService } from '../commitments/commitments.service';
import { RetentionService } from '../retention/retention.service';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import { ProjectsResourcingService } from './projects-resourcing.service';
import { ProjectsWbsService } from './projects-wbs.service';
import { ProjectsEvmService } from './projects-evm.service';
import { ProjectsPortfolioService } from './projects-portfolio.service';
import { ProjectsGateService } from './projects-gate.service';
import { ProgramBenefitsService } from './program-benefits.service';
import { r2, DEFAULT_REV_PER_FTE_MONTH, r4, depsCsv, csvToList, clamp15, riskScore, ragFor, addDays } from './projects.helpers';
import { shapeTemplateItem, shapeRisk, shapeChangeOrder, shapeBoqLine } from './projects.shapes';


export interface CreateProjectDto { project_code?: string; name: string; customer_name?: string; customer_no?: string; billing_type?: 'TM' | 'Fixed'; budget_amount?: number; contract_amount?: number; start_date?: string; end_date?: string; rev_method?: 'billing' | 'poc'; estimated_cost?: number; budget_tolerance_pct?: number }
export interface RecognizeDto { as_of?: string; estimated_cost?: number }
export interface ChangeOrderDto { description?: string; contract_delta?: number; budget_delta?: number; estimated_cost_delta?: number; reason?: string }
export interface CostDto { entry_type?: 'time' | 'expense'; description?: string; qty?: number; rate?: number; amount?: number; billable?: boolean; entry_date?: string }
export interface BillDto { amount?: number; percent?: number }
export interface FromOpportunityDto { project_code?: string; billing_type?: 'TM' | 'Fixed'; budget_amount?: number; start_date?: string; end_date?: string }
// PPM-B1 (PROJ-21): a richer alternative to plain `depends_on` ids — per-edge dep type (SS/FF/SF, default FS)
// + lag/lead in days. Omit `dependencies` and pass plain `depends_on` for the unchanged FS/lag-0 behaviour.
export interface TaskDependencyDto { task_id: number; type?: 'FS' | 'SS' | 'FF' | 'SF'; lag_days?: number }
export interface TaskDto { name: string; parent_id?: number; wbs_code?: string; status?: string; planned_start?: string; planned_end?: string; planned_hours?: number; planned_cost?: number; pct_complete?: number; assignee?: string; depends_on?: number[]; dependencies?: TaskDependencyDto[]; constraint_type?: 'SNET' | 'FNLT' | null; constraint_offset_days?: number | null; accountable?: string; responsible?: string[]; consulted?: string[]; informed?: string[] }
export interface TaskPatchDto { name?: string; status?: string; planned_start?: string; planned_end?: string; planned_hours?: number; planned_cost?: number; pct_complete?: number; assignee?: string; depends_on?: number[]; dependencies?: TaskDependencyDto[]; constraint_type?: 'SNET' | 'FNLT' | null; constraint_offset_days?: number | null; accountable?: string; responsible?: string[]; consulted?: string[]; informed?: string[] }
export interface ProjectCalendarDto { enabled?: boolean; non_working_weekdays?: number[] }
export interface CalendarExceptionDto { exception_date: string; description?: string }
// PROJ-25 portfolio selection scenarios (PPM Wave P4)
export interface PortfolioScenarioDto { name: string; budget_envelope?: number; objective?: string; notes?: string }
export interface PortfolioItemDto { project_code: string; decision?: 'include' | 'exclude'; priority_score?: number; rationale?: string }
export interface PortfolioCommitDto { override?: boolean; override_reason?: string; self_approval_reason?: string }
// PROJ-26 project phase-gate governance (PPM Wave P4)
export interface PhaseGateDto { target_phase: string; gate_key?: string; name?: string; readiness?: string }
export interface GateDecisionDto { decision: 'go' | 'hold' | 'kill'; notes?: string; self_approval_reason?: string }
// PROJ-27 program benefits realization (PPM Wave P4)
export interface BenefitDto { name: string; category?: 'financial' | 'non_financial'; unit?: string; baseline_value?: number; target_value: number; target_date?: string; owner?: string }
export interface BenefitMeasurementDto { measured_value: number; measured_at?: string; note?: string }
export interface BenefitConfirmDto { result: 'realized' | 'not_realized'; notes?: string; self_approval_reason?: string }
export interface MilestoneDto { name: string; due_date?: string; owner?: string; billing_percent?: number }
export interface RateCardDto { role: string; cost_rate?: number; bill_rate?: number; effective_from?: string; effective_to?: string }
export interface ResourceDto { resource_name: string; role?: string; task_id?: number; alloc_pct?: number; period_start?: string; period_end?: string }
export interface ResourceSkillDto { resource_name: string; skill: string; proficiency?: string }
export interface ResourceCalendarDto { resource_name: string; month: string; available_pct?: number; reason?: string }
export interface BaselineDto { label?: string; reason?: string }
// PPM-B2 (PROJ-22): a manual bottom-up estimate-to-complete entry. Omit `task_id` for a project-level
// (top-down override) entry; otherwise it's scoped to that one WBS task.
export interface EtcDto { task_id?: number; etc_amount: number; note?: string }
export interface ProgramDto { program_code?: string | null; depends_on_projects?: string[] }
export interface TemplateItemDto { item_type?: 'task' | 'milestone'; seq?: number; name: string; parent_seq?: number; wbs_code?: string; planned_hours?: number; planned_cost?: number; offset_start_days?: number; offset_end_days?: number; depends_on_seq?: number[]; billing_percent?: number; owner?: string; assignee?: string }
export interface TemplateDto { code?: string; name: string; description?: string; items?: TemplateItemDto[] }
export interface ApplyTemplateDto { start_date?: string }
export interface BoqLineDto { category?: 'material' | 'labor' | 'subcon' | 'other'; item_no?: string; task_id?: number; wbs_code?: string; description?: string; uom?: string; budget_qty?: number; rate?: number; budget_amount?: number }
export interface BoqDto { title?: string; boq_no?: string; lines?: BoqLineDto[] }
export interface RemeasureDto { remeasured_qty: number }
export interface RiskDto { kind?: 'risk' | 'issue'; title: string; probability?: number; impact?: number; owner?: string; mitigation?: string; due_date?: string }
export interface RiskPatchDto { status?: 'open' | 'mitigating' | 'closed'; probability?: number; impact?: number; owner?: string; mitigation?: string; due_date?: string; title?: string }


@Injectable()
export class ProjectsService {
  private readonly resourcing: ProjectsResourcingService;
  private readonly wbs: ProjectsWbsService;
  private readonly evmSvc: ProjectsEvmService;
  private readonly portfolio: ProjectsPortfolioService;
  private readonly gates: ProjectsGateService;
  private readonly benefits: ProgramBenefitsService;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
    // Optional so partial harnesses (and any consumer that constructs the service without the bus) still
    // build; when present, the action center pushes a `project_action` SSE event on red/unmitigated-high.
    @Optional() private readonly live?: BiLiveService,
    // M1 (PROJ-12) — the BoQ-line encumbrance ledger; when present, getBoq shows budget/committed/remaining
    // per line and listCommitments exposes the project commitments. @Optional so partial harnesses still build.
    @Optional() private readonly commitments?: CommitmentsService,
    // docs/35 Depth-1 — the shared retention sub-ledger; when present, the action center surfaces retention
    // release tranches due for action (`retention_due`). @Optional so partial harnesses still build.
    @Optional() private readonly retention?: RetentionService,
  ) {
    // docs/38 projects PR-2: built in the ctor BODY (not DI) — the goldenmaster constructs this service
    // positionally with (db, ledger) only, so sub-services must come from the already-injected deps.
    this.resourcing = new ProjectsResourcingService(db, (code) => this.row(code));
    this.wbs = new ProjectsWbsService(db, (code) => this.row(code), (code, dto, user) => this.bill(code, dto, user));
    this.evmSvc = new ProjectsEvmService(db, this.wbs, (code) => this.row(code), (code) => this.get(code), (pr, nb) => this.fmt(pr, nb), (t, k, sev, c, x) => this.emitAction(t, k, sev, c, x));
    this.portfolio = new ProjectsPortfolioService(db);
    this.gates = new ProjectsGateService(db, (code) => this.row(code));
    this.benefits = new ProgramBenefitsService(db);
  }

  // Best-effort proactive push to the live bus (PMO-1). Never throws — a missing/failed bus must not break
  // the underlying capture/log; the action-center page also polls, so a dropped event self-heals.
  private emitAction(tenantId: number | null | undefined, kind: string, severity: string, projectCode: string, extra: Record<string, any> = {}) {
    try { this.live?.publish({ type: 'project_action', tenant_id: tenantId ?? null, kind, severity, project_code: projectCode, ...extra }); } catch { /* bus optional */ }
  }

  async create(dto: CreateProjectDto, user: JwtUser) {
    const db = this.db;
    const code = dto.project_code?.trim() || `PRJ${String(Date.now()).slice(-6)}`;
    const revMethod = dto.rev_method === 'poc' ? 'poc' : 'billing';
    await db.insert(projects).values({
      tenantId: user.tenantId ?? null, projectCode: code, name: dto.name, customerName: dto.customer_name ?? null, customerNo: dto.customer_no ?? null,
      billingType: dto.billing_type ?? 'TM', budgetAmount: fx(dto.budget_amount ?? 0, 2), contractAmount: fx(dto.contract_amount ?? 0, 2),
      revMethod, estimatedCost: fx(dto.estimated_cost ?? 0, 2), budgetTolerancePct: fx(Math.max(0, dto.budget_tolerance_pct ?? 0), 3),
      status: 'Open', startDate: dto.start_date ?? null, endDate: dto.end_date ?? null, createdBy: user.username,
    });
    return this.get(code);
  }

  // Convert a WON CRM opportunity (crm_opportunities) into a project (CRM-WL). The deal's value seeds the
  // project contract; we stamp customer_no + crm_opp_no so margin traces back to the deal it came from.
  // Guards: only a won opportunity converts (an open/lost deal is rejected), and a given opportunity converts
  // to at most ONE project (idempotent on crm_opp_no) so a re-submit can't spawn duplicate projects.
  async createFromOpportunity(oppNo: string, dto: FromOpportunityDto, user: JwtUser) {
    const db = this.db;
    const oc = [eq(crmOpportunities.oppNo, oppNo)];
    if (user.tenantId != null) oc.push(eq(crmOpportunities.tenantId, user.tenantId));
    const [opp] = await db.select().from(crmOpportunities).where(and(...oc)).limit(1);
    if (!opp) throw new NotFoundException({ code: 'OPP_NOT_FOUND', message: `Opportunity ${oppNo} not found`, messageTh: 'ไม่พบโอกาสการขาย' });
    if (opp.stage !== 'won') throw new BadRequestException({ code: 'OPP_NOT_WON', message: `Only a won opportunity converts to a project (stage=${opp.stage})`, messageTh: 'แปลงเป็นโครงการได้เฉพาะโอกาสที่ชนะแล้ว' });
    const [existing] = await db.select().from(projects).where(eq(projects.crmOppNo, oppNo)).limit(1);
    if (existing) return { already: true, ...(await this.get(existing.projectCode)) };
    // Customer-of-record name (falls back to the opportunity name if the deal has no customer_master link).
    let customerName: string | null = null;
    if (opp.customerNo) {
      const cc = [eq(customerMaster.customerNo, opp.customerNo)];
      if (user.tenantId != null) cc.push(eq(customerMaster.tenantId, user.tenantId));
      const [c] = await db.select().from(customerMaster).where(and(...cc)).limit(1);
      customerName = c?.name ?? null;
    }
    const code = dto.project_code?.trim() || `PRJ${String(Date.now()).slice(-6)}`;
    const contract = r2(n(opp.amount));
    await db.insert(projects).values({
      tenantId: user.tenantId ?? null, projectCode: code, name: opp.name, customerName,
      customerNo: opp.customerNo ?? null, crmOppNo: oppNo,
      billingType: dto.billing_type ?? 'Fixed', budgetAmount: fx(dto.budget_amount ?? 0, 2), contractAmount: fx(contract, 2),
      status: 'Open', startDate: dto.start_date ?? null, endDate: dto.end_date ?? null, createdBy: user.username,
    });
    return this.get(code);
  }

  // Log a cost (time/expense). A BILLABLE cost is a recoverable asset → capitalised in project WIP (Dr 1260
  // / Cr 2390) and relieved to COGS at billing. A NON-BILLABLE cost is unrecoverable, so it is EXPENSED
  // immediately to project COGS (Dr 5800 / Cr 2390) and never enters the billable WIP — you can't bill the
  // customer for it, and conservative accounting must not carry it as a recoverable asset.
  async logCost(code: string, dto: CostDto, user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    const amount = r2(dto.amount != null ? n(dto.amount) : n(dto.qty) * n(dto.rate));
    if (amount <= 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Cost amount must be positive', messageTh: 'จำนวนต้นทุนต้องมากกว่าศูนย์' });
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const billable = dto.billable !== false; // default true

    const [e] = await db.insert(projectEntries).values({
      projectId: Number(p.id), tenantId, entryType: dto.entry_type ?? 'time', description: dto.description ?? null,
      qty: fx(dto.qty ?? 0, 2), rate: fx(dto.rate ?? 0, 2), amount: fx(amount, 2), billable,
      entryDate: dto.entry_date ?? ymd(), createdBy: user.username,
    }).returning({ id: projectEntries.id });

    const conv = dto.entry_type === 'expense' ? 'Project expense' : 'Project labor';
    // docs/43 PR-4: the applied-clearing + non-billable-cost legs follow the tenant posting-rules
    // (PROJECT.COST) ?? registry defaults; the 1260 project-WIP control (cost_to_date tie) stays pinned.
    const costOvr = await this.ledger.postingOverrides('PROJECT.COST', tenantId);
    const appliedAcct = costOvr.proj_applied ?? postingDefault('PROJECT.COST', 'proj_applied');
    const je: any = await this.ledger.postEntry({
      source: 'PRJ-COST', sourceRef: `${code}:${Number(e!.id)}`, tenantId, memo: `Project cost ${code}${billable ? '' : ' (non-billable)'}`, createdBy: user.username,
      lines: billable
        ? [{ account_code: '1260', debit: amount, memo: `WIP ${code}` }, { account_code: appliedAcct, credit: amount, memo: conv }]
        : [{ account_code: costOvr.project_cogs ?? postingDefault('PROJECT.COST', 'project_cogs'), debit: amount, memo: `Non-billable cost ${code}` }, { account_code: appliedAcct, credit: amount, memo: conv }],
    });
    await db.update(projectEntries).set({ entryNo: je.entry_no }).where(eq(projectEntries.id, Number(e!.id)));
    // Only billable costs accumulate in the recoverable WIP (cost_to_date); non-billable are already expensed.
    const costToDate = billable ? r2(n(p.costToDate) + amount) : n(p.costToDate);
    await db.update(projects).set({ costToDate: fx(costToDate, 2), status: p.status === 'Open' ? 'Active' : p.status }).where(eq(projects.id, Number(p.id)));
    return { project_code: code, entry_no: je.entry_no, amount, billable, cost_to_date: costToDate };
  }

  // Bill the customer → recognize revenue + relieve outstanding WIP to cost of services.
  // GL: Dr 1100 AR / Cr 4200 Revenue ; Dr 5800 COGS / Cr 1260 WIP (for the unrecognized cost).
  async bill(code: string, dto: BillDto, user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    // Milestone / progressive billing: a Fixed-price contract can be billed by PERCENT of the contract
    // value (e.g. 30% at a phase) instead of a raw amount. T&M still bills a raw amount.
    let bill: number;
    if (dto.percent != null) {
      if (n(p.contractAmount) <= 0) throw new BadRequestException({ code: 'NO_CONTRACT', message: 'Percent billing requires a contract amount', messageTh: 'การวางบิลตาม % ต้องมีมูลค่าสัญญา' });
      bill = r2(n(p.contractAmount) * n(dto.percent) / 100);
    } else {
      bill = r2(n(dto.amount));
    }
    if (bill <= 0) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'Bill amount must be positive', messageTh: 'จำนวนเงินวางบิลต้องมากกว่าศูนย์' });
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const newBilled = r2(n(p.billedToDate) + bill);
    // Fixed-price guard: cumulative billing can never exceed the contract value (over-billing the customer).
    if (p.billingType === 'Fixed' && n(p.contractAmount) > 0 && newBilled > n(p.contractAmount) + 0.01)
      throw new BadRequestException({ code: 'BILL_EXCEEDS_CONTRACT', message: `Billing ${bill} would exceed the contract ${n(p.contractAmount)} (already billed ${n(p.billedToDate)})`, messageTh: 'วางบิลเกินมูลค่าสัญญา' });
    if (await this.ledger.alreadyPosted('PRJ-BILL', `${code}:${newBilled}`, tenantId)) return { already: true, project_code: code };

    // POC project (PROJ-09): revenue + cost are recognised over time (recognizePoc), NOT at billing — so a
    // bill is just an INVOICE: Dr 1100 AR, clearing the contract asset (1265) already earned, with any excess
    // over earned revenue parked as a contract liability (2410, billings in excess of recognised revenue).
    if (p.revMethod === 'poc') {
      const contractAsset = r2(Math.max(0, n(p.recognizedRevenue) - n(p.billedToDate)));
      const clearAsset = r2(Math.min(bill, contractAsset));
      const toLiability = r2(bill - clearAsset);
      const lines: any[] = [{ account_code: '1100', debit: bill, memo: `AR ${code}` }];
      if (clearAsset > 0) lines.push({ account_code: '1265', credit: clearAsset, memo: `Contract asset billed ${code}` });
      if (toLiability > 0) lines.push({ account_code: '2410', credit: toLiability, memo: `Billings in excess ${code}` });
      const jeP: any = await this.ledger.postEntry({ source: 'PRJ-BILL', sourceRef: `${code}:${newBilled}`, tenantId, memo: `Project invoice ${code} (POC)`, createdBy: user.username, lines });
      await db.update(projects).set({ billedToDate: fx(newBilled, 2) }).where(eq(projects.id, Number(p.id)));
      return { project_code: code, entry_no: jeP.entry_no, billed: bill, revenue: 0, contract_asset_cleared: clearAsset, billings_in_excess: toLiability, rev_method: 'poc' };
    }

    const relieve = r2(Math.max(0, n(p.costToDate) - n(p.recognizedCost)));
    // docs/43 PR-4: revenue + COGS legs follow the tenant posting-rules (PROJECT.REVENUE) ?? registry
    // defaults; AR control (1100) and project WIP (1260) stay pinned.
    const revOvr = await this.ledger.postingOverrides('PROJECT.REVENUE', tenantId);
    const lines = [
      { account_code: '1100', debit: bill, memo: `AR ${code}` },
      { account_code: revOvr.project_revenue ?? postingDefault('PROJECT.REVENUE', 'project_revenue'), credit: bill, memo: 'Project revenue' },
    ];
    if (relieve > 0) {
      lines.push({ account_code: revOvr.project_cogs ?? postingDefault('PROJECT.REVENUE', 'project_cogs'), debit: relieve, memo: 'Project cost of services' });
      lines.push({ account_code: '1260', credit: relieve, memo: `WIP relieved ${code}` });
    }
    const je: any = await this.ledger.postEntry({ source: 'PRJ-BILL', sourceRef: `${code}:${newBilled}`, tenantId, memo: `Project billing ${code}`, createdBy: user.username, lines });

    await db.update(projects).set({ billedToDate: fx(newBilled, 2), recognizedCost: fx(n(p.recognizedCost) + relieve, 2) }).where(eq(projects.id, Number(p.id)));
    return { project_code: code, entry_no: je.entry_no, billed: bill, revenue: bill, cost_recognized: relieve, margin: r2(bill - relieve) };
  }

  // ── Over-time (percentage-of-completion) revenue recognition (PROJ-09) ────
  // Recognise earned revenue on a cost-to-cost basis: POC% = cost_to_date / estimated_total_cost (EAC),
  // capped at 100%. The PERIOD revenue = contract × POC% − revenue already recognised; the cost incurred but
  // not yet expensed is relieved from WIP to COGS in the same step. GL (period revenue): Dr 2410 then Dr 1265
  // / Cr 4200 (consume any billings-in-excess first, the rest a contract asset); (period cost): Dr 5800 / Cr
  // 1260. Only a Fixed-price `poc` project recognises this way; idempotent per (project, recognised total) so
  // a re-run posts nothing. Authorised (gl_post/exec); posts through the PERIOD_LOCKED + GL-audit gates.
  async recognizePoc(code: string, dto: RecognizeDto, user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    if (p.revMethod !== 'poc') throw new BadRequestException({ code: 'NOT_POC', message: 'Project is not on over-time (POC) revenue recognition', messageTh: 'โครงการนี้ไม่ได้ใช้การรับรู้รายได้ตามความสำเร็จของงาน' });
    const contract = n(p.contractAmount);
    if (contract <= 0) throw new BadRequestException({ code: 'NO_CONTRACT', message: 'POC recognition requires a contract amount', messageTh: 'การรับรู้รายได้ตามความสำเร็จต้องมีมูลค่าสัญญา' });
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    // EAC: an explicit estimate (this run or stored), else the project budget. Must be positive to form a ratio.
    if (dto.estimated_cost != null && n(dto.estimated_cost) > 0) await db.update(projects).set({ estimatedCost: fx(n(dto.estimated_cost), 2) }).where(eq(projects.id, Number(p.id)));
    const estCost = n(dto.estimated_cost ?? p.estimatedCost) > 0 ? n(dto.estimated_cost ?? p.estimatedCost) : n(p.budgetAmount);
    if (estCost <= 0) throw new BadRequestException({ code: 'NO_ESTIMATE', message: 'POC needs an estimated total cost (estimated_cost or budget)', messageTh: 'ต้องระบุประมาณการต้นทุนรวม' });

    const cost = n(p.costToDate);
    const pocPct = Math.min(100, r2((cost / estCost) * 100));
    const earnedToDate = r2(Math.min(contract, contract * pocPct / 100));
    const periodRevenue = r2(earnedToDate - n(p.recognizedRevenue));
    const periodCost = r2(Math.max(0, cost - n(p.recognizedCost)));
    if (periodRevenue <= 0.005 && periodCost <= 0.005) return { already: true, project_code: code, poc_pct: pocPct, recognized_revenue: n(p.recognizedRevenue) };
    const ref = `${code}:${earnedToDate}:${cost}`;
    if (await this.ledger.alreadyPosted('PRJ-REVREC', ref, tenantId)) return { already: true, project_code: code };

    // docs/43 PR-4: revenue + COGS legs follow the tenant posting-rules (PROJECT.REVENUE) ?? registry
    // defaults; 2410/1265 (progress-billing ties) and 1260 stay pinned/widen-gated.
    const pocOvr = await this.ledger.postingOverrides('PROJECT.REVENUE', tenantId);
    const lines: any[] = [];
    if (periodRevenue > 0.005) {
      // Recognise revenue: first reverse any billings-in-excess (2410), the remainder builds the contract asset (1265).
      const liability = r2(Math.max(0, n(p.billedToDate) - n(p.recognizedRevenue)));
      const fromLiability = r2(Math.min(periodRevenue, liability));
      const toAsset = r2(periodRevenue - fromLiability);
      if (fromLiability > 0) lines.push({ account_code: '2410', debit: fromLiability, memo: `Release billings in excess ${code}` });
      if (toAsset > 0) lines.push({ account_code: '1265', debit: toAsset, memo: `Contract asset ${code}` });
      lines.push({ account_code: pocOvr.project_revenue ?? postingDefault('PROJECT.REVENUE', 'project_revenue'), credit: periodRevenue, memo: `Project revenue (POC ${pocPct}%)` });
    }
    if (periodCost > 0.005) {
      lines.push({ account_code: pocOvr.project_cogs ?? postingDefault('PROJECT.REVENUE', 'project_cogs'), debit: periodCost, memo: 'Project cost of services' });
      lines.push({ account_code: '1260', credit: periodCost, memo: `WIP relieved ${code}` });
    }
    const je: any = await this.ledger.postEntry({ source: 'PRJ-REVREC', sourceRef: ref, tenantId, date: dto.as_of, memo: `Project POC revenue recognition ${code} (${pocPct}%)`, createdBy: user.username, lines });
    await db.update(projects).set({ recognizedRevenue: fx(n(p.recognizedRevenue) + periodRevenue, 2), recognizedCost: fx(n(p.recognizedCost) + periodCost, 2), status: p.status === 'Open' ? 'Active' : p.status }).where(eq(projects.id, Number(p.id)));
    return {
      project_code: code, entry_no: je.entry_no, poc_pct: pocPct, estimated_cost: estCost,
      revenue_recognized: periodRevenue, cost_recognized: periodCost,
      recognized_revenue_to_date: r2(n(p.recognizedRevenue) + periodRevenue), earned_to_date: earnedToDate, margin: r2(periodRevenue - periodCost),
    };
  }

  async list(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(projects).orderBy(desc(projects.id)).limit(100);
    // Aggregate the non-billable (already-expensed) cost per project so the register shows total cost + true margin.
    const nb = await db.select({ pid: projectEntries.projectId, v: sql<string>`coalesce(sum(${projectEntries.amount}),0)` })
      .from(projectEntries).where(eq(projectEntries.billable, false)).groupBy(projectEntries.projectId);
    const nbBy = new Map<number, number>(nb.map((x: any) => [Number(x.pid), n(x.v)]));
    return { projects: rows.map((r: any) => this.fmt(r, nbBy.get(Number(r.id)) ?? 0)), count: rows.length };
  }

  async get(code: string) {
    const db = this.db;
    const p = await this.row(code);
    const entries = await db.select().from(projectEntries).where(eq(projectEntries.projectId, Number(p.id))).orderBy(desc(projectEntries.id));
    const nonBillable = r2(entries.filter((e: any) => e.billable === false).reduce((s: number, e: any) => s + n(e.amount), 0));
    // P1: schedule progress — overall % complete rolls up from the project's WBS tasks (planned-hours-weighted).
    const tasks = await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id)));
    // M0 (docs/32): BoQ budget baseline summary (latest BoQ header) — null when the project has no BoQ.
    const [boq] = await db.select().from(projectBoq).where(eq(projectBoq.projectId, Number(p.id))).orderBy(desc(projectBoq.id)).limit(1);
    return {
      ...this.fmt(p, nonBillable),
      pct_complete: this.wbs.taskRollup(tasks),
      task_count: tasks.length,
      boq: boq ? { id: Number(boq.id), boq_no: boq.boqNo, status: boq.status, budget_total: n(boq.budgetTotal) } : null,
      entries: entries.map((e: any) => ({ entry_type: e.entryType, description: e.description, qty: n(e.qty), rate: n(e.rate), amount: n(e.amount), billable: e.billable !== false, entry_date: e.entryDate, entry_no: e.entryNo })),
    };
  }

















  // ── Earned-value management (P4, PROJ-06) ────────────────────────────────
  // Computes BAC / PV / EV / AC → CPI / SPI + cost & schedule variance + EAC/ETC from the project's WBS tasks
  // (planned cost, % complete, planned_end schedule) and its actual cost incurred, and reconciles EV/AC against
  // the project's WIP actuals. `as_of` defaults to the business day; PV counts tasks scheduled to finish by then.
  // ── docs/38 projects PR-4: EVM/schedule/programs/baselines/health live in ProjectsEvmService. ──
  async evm(code: string, asOf?: string) { return this.evmSvc.evm(code, asOf); }
  // PPM-B2 (PROJ-22): manual bottom-up ETC entry + the EAC-scenario comparison (formulaic vs bottom-up).
  async submitEtc(code: string, dto: EtcDto, user: JwtUser) { return this.evmSvc.submitEtc(code, dto, user); }
  async eacScenarios(code: string) { return this.evmSvc.eacScenarios(code); }
  async schedule(code: string) { return this.evmSvc.schedule(code); }
  async evmSeries(code: string, dto?: { months?: number; as_of?: string }) { return this.evmSvc.evmSeries(code, dto); }
  // PROJ-24: read-only change-order impact simulation (projected cost/margin/EVM before authorisation).
  async simulateChangeOrder(coId: number) { return this.evmSvc.simulateChangeOrder(coId); }
  async earnedSchedule(code: string, asOf?: string) { return this.evmSvc.earnedSchedule(code, asOf); }
  async setProgram(code: string, dto: ProgramDto, user: JwtUser) { return this.evmSvc.setProgram(code, dto, user); }
  async programCriticalPath(programCode: string, user: JwtUser) { return this.evmSvc.programCriticalPath(programCode, user); }
  async programs(user: JwtUser) { return this.evmSvc.programs(user); }
  async captureBaseline(code: string, dto: BaselineDto, user: JwtUser) { return this.evmSvc.captureBaseline(code, dto, user); }
  async getBaseline(code: string, user: JwtUser) { return this.evmSvc.getBaseline(code, user); }
  async captureHealth(code: string, dto: { as_of?: string }, user: JwtUser) { return this.evmSvc.captureHealth(code, dto, user); }
  async captureAllHealth(user: JwtUser) { return this.evmSvc.captureAllHealth(user); }
  async healthHistory(code: string) { return this.evmSvc.healthHistory(code); }

  // PPM-B1 (PROJ-21): opt-in per-tenant working calendar — schedule()'s duration calculation only skips
  // non-working weekdays/holidays when enabled (default false, unchanged behaviour).
  async getCalendar(user: JwtUser) { return this.evmSvc.getCalendar(user); }
  async setCalendar(dto: ProjectCalendarDto, user: JwtUser) { return this.evmSvc.setCalendar(dto, user); }
  async addCalendarException(dto: CalendarExceptionDto, user: JwtUser) { return this.evmSvc.addCalendarException(dto, user); }
  async listCalendarExceptions(user: JwtUser) { return this.evmSvc.listCalendarExceptions(user); }

  // ── PROJ-25 (PPM Wave P4): portfolio selection scenarios live in ProjectsPortfolioService; thin delegators. ──
  async createPortfolioScenario(dto: PortfolioScenarioDto, user: JwtUser) { return this.portfolio.createScenario(dto, user); }
  async listPortfolioScenarios(user: JwtUser) { return this.portfolio.listScenarios(user); }
  async getPortfolioScenario(scenarioNo: string) { return this.portfolio.analyze(scenarioNo); }
  async upsertPortfolioItem(scenarioNo: string, dto: PortfolioItemDto, user: JwtUser) { return this.portfolio.upsertItem(scenarioNo, dto, user); }
  async removePortfolioItem(scenarioNo: string, projectCode: string, user: JwtUser) { return this.portfolio.removeItem(scenarioNo, projectCode, user); }
  async commitPortfolioScenario(scenarioNo: string, dto: PortfolioCommitDto, user: JwtUser) { return this.portfolio.commitScenario(scenarioNo, dto, user); }

  // ── PROJ-26 (PPM Wave P4): project phase-gate governance lives in ProjectsGateService; thin delegators. ──
  async listPhaseGates(code: string) { return this.gates.listGates(code); }
  async submitPhaseGate(code: string, dto: PhaseGateDto, user: JwtUser) { return this.gates.submitGate(code, dto, user); }
  async decidePhaseGate(gateId: number, dto: GateDecisionDto, user: JwtUser) { return this.gates.decideGate(gateId, dto, user); }

  // ── PROJ-27 (PPM Wave P4): program benefits realization lives in ProgramBenefitsService; thin delegators. ──
  async listProgramBenefits(programCode: string) { return this.benefits.listBenefits(programCode); }
  async declareProgramBenefit(programCode: string, dto: BenefitDto, user: JwtUser) { return this.benefits.declareBenefit(programCode, dto, user); }
  async recordBenefitMeasurement(benefitId: number, dto: BenefitMeasurementDto, user: JwtUser) { return this.benefits.recordMeasurement(benefitId, dto, user); }
  async confirmProgramBenefit(benefitId: number, dto: BenefitConfirmDto, user: JwtUser) { return this.benefits.confirmBenefit(benefitId, dto, user); }

  // ── docs/38 projects PR-3: WBS (tasks/milestones/RACI) lives in ProjectsWbsService; thin delegators. ──
  async addTask(code: string, dto: TaskDto, user: JwtUser) { return this.wbs.addTask(code, dto, user); }
  async listTasks(code: string) { return this.wbs.listTasks(code); }
  async patchTask(taskId: number, dto: TaskPatchDto, user: JwtUser) { return this.wbs.patchTask(taskId, dto, user); }
  async myTasks(user: JwtUser) { return this.wbs.myTasks(user); }
  async raci(code: string) { return this.wbs.raci(code); }
  async addMilestone(code: string, dto: MilestoneDto, user: JwtUser) { return this.wbs.addMilestone(code, dto, user); }
  async listMilestones(code: string) { return this.wbs.listMilestones(code); }
  async reachMilestone(milestoneId: number, user: JwtUser) { return this.wbs.reachMilestone(milestoneId, user); }

  // ── docs/38 projects PR-2: resourcing (PROJ-05) lives in ProjectsResourcingService; thin delegators. ──
  async addRateCard(dto: RateCardDto, user: JwtUser) { return this.resourcing.addRateCard(dto, user); }
  async listRateCards(user: JwtUser) { return this.resourcing.listRateCards(user); }
  async assignResource(code: string, dto: ResourceDto, user: JwtUser) { return this.resourcing.assignResource(code, dto, user); }
  async listResources(code: string) { return this.resourcing.listResources(code); }
  async resourceUtilization(user: JwtUser) { return this.resourcing.resourceUtilization(user); }
  async resourceCapacity(user: JwtUser, dto?: { months?: number; from?: string }) { return this.resourcing.resourceCapacity(user, dto); }
  async upsertResourceSkill(dto: ResourceSkillDto, user: JwtUser) { return this.resourcing.upsertResourceSkill(dto, user); }
  async listResourceSkills(user: JwtUser) { return this.resourcing.listResourceSkills(user); }
  async upsertResourceCalendar(dto: ResourceCalendarDto, user: JwtUser) { return this.resourcing.upsertResourceCalendar(dto, user); }
  async listResourceCalendar(user: JwtUser, resourceName?: string) { return this.resourcing.listResourceCalendar(user, resourceName); }
  async roleSupplyDemand(user: JwtUser, dto?: { months?: number; from?: string }) { return this.resourcing.roleSupplyDemand(user, dto); }

  // ── Resource leveling (PPM-A2, PROJ-23) ───────────────────────────────────
  // Detects a month where a named resource is over-allocated WITHIN this project's own assignments (the
  // same calendar-aware ceiling as the tenant-wide resourceCapacity heatmap — default 100% absent a
  // resource_calendar override), then cross-references the CPM schedule's per-task SLACK (schedule(),
  // PROJ-06/21) to suggest which task-linked assignment could be shifted later — by up to its slack, in
  // days — without delaying the critical path. An over-allocated resource-month where every contributing
  // task is already on the critical path (slack 0) is flagged NO_SLACK: genuinely unresolvable without
  // accepting a project delay. Project-scoped (unlike the tenant-wide resourceCapacity) because slack is a
  // property of THIS project's own schedule. Read-only/detective — suggests, never moves anything; a
  // project with no over-allocated resource carries empty over_allocations/suggestions/unresolvable.
  // Composed directly in the facade (spans both evmSvc's schedule and the resourcing sub-service's data),
  // mirroring the existing forecast() cross-sub-service composition.
  async resourceLeveling(code: string, _user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    const sched = await this.evmSvc.schedule(code);
    const slackByTask = new Map<number, number>(sched.tasks.map((t: any) => [t.id, Number(t.slack) || 0]));
    const taskById = new Map<number, any>(sched.tasks.map((t: any) => [t.id, t]));

    const assignments = (await db.select().from(projectResources).where(eq(projectResources.projectId, Number(p.id))))
      .filter((r: any) => r.taskId != null)
      .map((r: any) => {
        const t = taskById.get(Number(r.taskId));
        return { ...r, effStart: r.periodStart ?? t?.planned_start ?? null, effEnd: r.periodEnd ?? t?.planned_end ?? null };
      });

    const calendarRows = await db.select().from(resourceCalendar);
    const availByResMonth = new Map<string, number>();
    for (const c of calendarRows) availByResMonth.set(`${c.resourceName}|${String(c.month).slice(0, 7)}`, n(c.availablePct));

    const activeIn = (ps: string | null, pe: string | null, month: string) => {
      const mStart = `${month}-01`, mEnd = `${month}-31`;
      return (ps == null || ps <= mEnd) && (pe == null || pe >= mStart);
    };
    const months = new Set<string>();
    for (const r of assignments) {
      if (r.effStart) months.add(String(r.effStart).slice(0, 7));
      if (r.effEnd) months.add(String(r.effEnd).slice(0, 7));
    }

    const byResMonth = new Map<string, { alloc: number; contributors: { taskId: number; allocPct: number }[] }>();
    for (const month of months) {
      for (const r of assignments) {
        if (!activeIn(r.effStart, r.effEnd, month)) continue;
        const key = `${r.resourceName}|${month}`;
        const bucket = byResMonth.get(key) ?? { alloc: 0, contributors: [] };
        bucket.alloc = r2(bucket.alloc + n(r.allocPct));
        bucket.contributors.push({ taskId: Number(r.taskId), allocPct: n(r.allocPct) });
        byResMonth.set(key, bucket);
      }
    }

    const overAllocations: any[] = [], suggestions: any[] = [], unresolvable: any[] = [];
    for (const [key, bucket] of byResMonth) {
      const [resourceName, month] = key.split('|');
      const available = availByResMonth.get(key) ?? 100;
      if (bucket.alloc <= available) continue;
      overAllocations.push({ resource_name: resourceName, month, allocated_pct: r2(bucket.alloc), available_pct: available, over_by_pct: r2(bucket.alloc - available) });
      const candidates = bucket.contributors
        .map((c) => ({ ...c, slack: slackByTask.get(c.taskId) ?? 0, task: taskById.get(c.taskId) }))
        .filter((c) => c.slack > 0)
        .sort((a, b) => b.slack - a.slack);
      const top = candidates[0];
      if (!top) { unresolvable.push({ resource_name: resourceName, month, reason: 'NO_SLACK' }); continue; }
      const newStart = top.task?.planned_start ? addDays(top.task.planned_start, top.slack) : null;
      suggestions.push({
        resource_name: resourceName, month, task_id: top.taskId, task_name: top.task?.name ?? null,
        alloc_pct: top.allocPct, slack_days: top.slack, suggested_shift_days: top.slack,
        shifted_to_month: newStart ? newStart.slice(0, 7) : null,
      });
    }
    return {
      project_code: code,
      over_allocations: overAllocations.sort((a, b) => a.month.localeCompare(b.month) || a.resource_name.localeCompare(b.resource_name)),
      suggestions: suggestions.sort((a, b) => a.month.localeCompare(b.month)),
      unresolvable: unresolvable.sort((a, b) => a.month.localeCompare(b.month)),
      over_allocated_count: overAllocations.length,
    };
  }






  // Portfolio command center (A1): an executive cross-project rollup — EVM totals, project-health buckets,
  // status + financial totals, the at-risk list, resource capacity, and the pipeline→delivery funnel. Also
  // backs the schedulable `project_evm` BI report. Read-only — rides evm() / resourceUtilization() / crm.
  async portfolioEvm(user: JwtUser) {
    const db = this.db;
    const list = await this.list(user);
    const rows: any[] = [];
    let bac = 0, ev = 0, ac = 0, eac = 0, contract = 0, billed = 0, wip = 0, margin = 0, costToDate = 0;
    const status_counts: Record<string, number> = {};
    const health = { on_track: 0, at_risk: 0, no_data: 0 };
    for (const p of list.projects) {
      const e = await this.evm(p.project_code);
      const hasData = e.cpi != null || e.spi != null;
      const risky = (e.cpi != null && e.cpi < 0.9) || (e.spi != null && e.spi < 0.9);
      if (!hasData) health.no_data++; else if (risky) health.at_risk++; else health.on_track++;
      rows.push({ project_code: p.project_code, name: p.name, status: p.status, customer_name: p.customer_name, billing_type: p.billing_type, cpi: e.cpi, spi: e.spi, bac: e.bac, ev: e.ev, ac: e.ac, eac: e.eac, wip: p.wip, margin: p.margin, on_track: hasData && !risky });
      bac = r2(bac + e.bac); ev = r2(ev + e.ev); ac = r2(ac + e.ac); eac = r2(eac + e.eac);
      contract = r2(contract + n(p.contract_amount)); billed = r2(billed + n(p.billed_to_date)); wip = r2(wip + n(p.wip)); margin = r2(margin + n(p.margin)); costToDate = r2(costToDate + n(p.cost_to_date));
      status_counts[p.status] = (status_counts[p.status] ?? 0) + 1;
    }
    const at_risk = rows
      .filter((r) => (r.cpi != null && r.cpi < 0.9) || (r.spi != null && r.spi < 0.9))
      .map((r) => ({ project_code: r.project_code, name: r.name, cpi: r.cpi, spi: r.spi }))
      .sort((a, b) => (a.cpi ?? 9) - (b.cpi ?? 9));
    const cap = await this.resourceUtilization(user);
    // Pipeline → delivery funnel: open + won opportunities (crm), and projects originated from a won deal.
    const OPEN = ['prospecting', 'qualification', 'proposal', 'negotiation'];
    const opps = await db.select().from(crmOpportunities);
    let open_count = 0, open_amount = 0, won_count = 0, won_amount = 0;
    for (const o of opps) {
      const amt = n(o.amount);
      if (OPEN.includes(o.stage)) { open_count++; open_amount = r2(open_amount + amt); }
      else if (o.stage === 'won') { won_count++; won_amount = r2(won_amount + amt); }
    }
    const converted_count = list.projects.filter((p: any) => p.crm_opp_no).length;
    return {
      as_of: ymd(), count: rows.length,
      status_counts,
      financials: { contract, billed, wip, margin, cost_to_date: costToDate },
      totals: { bac, ev, ac, eac, cpi: ac > 0 ? r4(ev / ac) : null },
      health,
      capacity: { over_allocated_count: cap.over_allocated_count, top: cap.utilization.slice(0, 5) },
      funnel: { open_count, open_amount, won_count, won_amount, converted_count },
      at_risk, projects: rows,
    };
  }

  // ── Action center / exception inbox (PMO-1, PROJ-11) ─────────────────────
  // One severity-ranked "what needs me now" worklist across all the caller's projects, assembled from the
  // signals the modules already produce — pure aggregation, posts nothing (detective control PROJ-11):
  //  • maker-checker queues awaiting a *different* approver: pending change orders, pending project timesheets;
  //  • risk governance: open HIGH risks with no mitigation plan (PROJ-08);
  //  • performance: red projects (CPI/SPI < 0.9) and over-budget projects;
  //  • schedule: milestones past their due date and not yet reached;
  //  • governance gaps: an Open project with no change-controlled baseline (PROJ-07) or a stale health
  //    snapshot (none in `stale_days`, default 14). Each item deep-links to the offending project tab.
  async actionCenter(user: JwtUser, dto?: { stale_days?: number }) {
    const db = this.db;
    const today = ymd();
    const staleDays = dto?.stale_days != null && Number(dto.stale_days) > 0 ? Math.floor(Number(dto.stale_days)) : 14;
    const staleCutoff = addDays(today, -staleDays);
    // Project universe the caller can see (RLS-scoped); everything below is bounded to this id set so the
    // cross-project queries never leak another tenant's rows.
    const pRows = await db.select().from(projects).orderBy(desc(projects.id)).limit(100);
    const codeById = new Map<number, string>(pRows.map((p: any) => [Number(p.id), p.projectCode]));
    const ids = new Set<number>(pRows.map((p: any) => Number(p.id)));
    const fmtByCode = new Map<string, any>((await this.list(user)).projects.map((p: any) => [p.project_code, p]));

    const items: any[] = [];
    const SEV_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const push = (kind: string, severity: 'high' | 'medium' | 'low', projectId: number | null, code: string | null, titleTh: string, titleEn: string, ref: string | null, tab: string, meta: Record<string, any> = {}) => {
      items.push({ kind, severity, project_id: projectId, project_code: code, title_th: titleTh, title_en: titleEn, ref, href: code ? `/projects/${code}?tab=${tab}` : '/projects', as_of: today, meta });
    };

    // Per-project performance + governance signals.
    const baseRows = await db.select({ pid: projectBaselines.projectId }).from(projectBaselines).where(eq(projectBaselines.status, 'active'));
    const hasBaseline = new Set<number>(baseRows.map((b: any) => Number(b.pid)));
    const snapRows = await db.select({ pid: projectHealthSnapshots.projectId, last: sql<string>`max(${projectHealthSnapshots.snapshotDate})` }).from(projectHealthSnapshots).groupBy(projectHealthSnapshots.projectId);
    const lastSnap = new Map<number, string>(snapRows.map((s: any) => [Number(s.pid), s.last]));
    for (const p of pRows) {
      const pid = Number(p.id); const code = p.projectCode;
      const f = fmtByCode.get(code);
      if (f?.over_budget) push('over_budget', 'high', pid, code, `เกินงบประมาณ (${f.budget_used_pct}%)`, `Over budget (${f.budget_used_pct}%)`, `${f.budget_used_pct}%`, 'costs', { budget_used_pct: f.budget_used_pct, budget_variance: f.budget_variance });
      const e = await this.evm(code);
      const isRed = (e.cpi != null && e.cpi < 0.9) || (e.spi != null && e.spi < 0.9);
      if (isRed) push('project_red', 'high', pid, code, `สุขภาพโครงการแดง (CPI ${e.cpi ?? '—'} / SPI ${e.spi ?? '—'})`, `Project health red (CPI ${e.cpi ?? '—'} / SPI ${e.spi ?? '—'})`, `CPI ${e.cpi ?? '—'}`, 'overview', { cpi: e.cpi, spi: e.spi });
      // Earned-schedule slip (PROJ-19): late in a project the classic SPI (EV/PV) converges to 1 even when
      // delivery is late — the time-based SPI(t) keeps degrading, so it catches slips the PV-based red check
      // above no longer sees. Suppressed when the project already reads red (no duplicate worklist item).
      if (!isRed) {
        const esm = await this.earnedSchedule(code).catch(() => null);
        if (esm?.spi_t != null && esm.spi_t < 0.9)
          push('schedule_slip_es', 'medium', pid, code, `เวลาหลุดแผนตาม Earned Schedule (SPI(t) ${esm.spi_t})`, `Schedule slipping by earned schedule (SPI(t) ${esm.spi_t})`, `SPI(t) ${esm.spi_t}`, 'overview', { spi_t: esm.spi_t, sv_t_months: esm.sv_t_months, spi: e.spi });
      }
      const inFlight = p.status !== 'Closed'; // an in-flight (Open/Active) project should be baselined + tracked
      if (inFlight && !hasBaseline.has(pid)) push('no_baseline', 'medium', pid, code, 'ยังไม่มีเส้นฐาน (baseline)', 'No change-controlled baseline', null, 'overview', {});
      const ls = lastSnap.get(pid);
      if (inFlight && (!ls || ls < staleCutoff)) push('stale_health', 'low', pid, code, ls ? `สุขภาพล่าสุด ${ls} (เก่ากว่า ${staleDays} วัน)` : 'ยังไม่เคยบันทึกสุขภาพ', ls ? `Last health ${ls} (older than ${staleDays}d)` : 'No health snapshot captured', ls ?? null, 'overview', { last_snapshot: ls ?? null, stale_days: staleDays });
    }

    // Pending change orders awaiting a different approver (maker-checker, PROJ-10).
    const coRows = await db.select().from(projectChangeOrders).where(eq(projectChangeOrders.status, 'pending'));
    for (const c of coRows) {
      const pid = Number(c.projectId); if (!ids.has(pid)) continue;
      const code = codeById.get(pid) ?? null;
      push('change_order_pending', 'medium', pid, code, `ใบสั่งเปลี่ยนแปลงรออนุมัติ (${c.coNo})`, `Change order awaiting approval (${c.coNo})`, c.coNo, 'overview', { co_no: c.coNo, requested_by: c.requestedBy, contract_delta: n(c.contractDelta) });
    }

    // Over-budget material requisitions awaiting an authoriser (maker-checker, PROJ-13 — M2).
    const pmrRows = await db.select().from(projectMaterialRequisitions).where(eq(projectMaterialRequisitions.status, 'pending'));
    for (const m of pmrRows) {
      const pid = Number(m.projectId); if (!ids.has(pid)) continue;
      const code = codeById.get(pid) ?? null;
      push('pmr_over_budget', 'high', pid, code, `ใบขอเบิกวัสดุเกินงบรออนุมัติ (${m.pmrNo})`, `Over-budget material requisition awaiting approval (${m.pmrNo})`, m.pmrNo, 'boq', { pmr_no: m.pmrNo, requested_by: m.requestedBy, over_amount: n(m.overAmount) });
    }

    // Pending project timesheets awaiting independent approval (maker-checker labor, PROJ-04).
    const tsRows = await db.select().from(timesheets).where(eq(timesheets.status, 'Pending'));
    const tsByProject = new Map<number, number>();
    for (const t of tsRows) {
      const pid = t.projectId != null ? Number(t.projectId) : null;
      if (pid == null || !ids.has(pid)) continue;
      tsByProject.set(pid, (tsByProject.get(pid) ?? 0) + 1);
    }
    for (const [pid, count] of tsByProject) {
      const code = codeById.get(pid) ?? null;
      push('timesheet_pending', 'medium', pid, code, `ใบลงเวลารออนุมัติ (${count})`, `Project timesheets awaiting approval (${count})`, String(count), 'costs', { count });
    }

    // Milestones past due and not yet reached (schedule slip).
    const msRows = await db.select().from(projectMilestones).where(eq(projectMilestones.status, 'pending'));
    for (const m of msRows) {
      const pid = Number(m.projectId); if (!ids.has(pid)) continue;
      if (!m.dueDate || String(m.dueDate) >= today) continue;
      const code = codeById.get(pid) ?? null;
      push('milestone_slipping', 'medium', pid, code, `หมุดหมายเลยกำหนด: ${m.name} (${m.dueDate})`, `Milestone overdue: ${m.name} (${m.dueDate})`, m.dueDate, 'milestones', { milestone: m.name, due_date: m.dueDate });
    }

    // Open HIGH risks with no mitigation plan (PROJ-08) — reuse the portfolio top-risk roll-up.
    const risks = await this.topRisks(user);
    for (const r of risks.top) {
      if (r.rag !== 'red' || r.mitigation) continue;
      push('risk_unmitigated_high', 'high', r.project_id ?? null, r.project_code ?? null, `ความเสี่ยงสูงยังไม่มีแผนรับมือ: ${r.title}`, `Unmitigated high risk: ${r.title}`, r.title, 'risks', { risk_id: r.id, score: r.score });
    }

    // Retention release tranches whose due date has passed (docs/35 Depth-1) — the withheld retention is now
    // collectible (customer) / payable (subcontractor) and should be released. Bounded to the caller's projects.
    if (this.retention) {
      const due = await this.retention.due(today).catch(() => null);
      for (const d of due?.due ?? []) {
        const pid = d.project_id != null ? Number(d.project_id) : null;
        if (pid == null || !ids.has(pid)) continue;
        const code = codeById.get(pid) ?? null;
        const th = d.party_type === 'subcontractor' ? 'เงินประกันผลงานผู้รับเหมาช่วงถึงกำหนดคืน' : 'เงินประกันผลงานลูกค้าถึงกำหนดคืน';
        const en = d.party_type === 'subcontractor' ? 'Subcontractor retention due for release' : 'Customer retention due for release';
        push('retention_due', 'medium', pid, code, `${th} (${d.source_doc_no}, ${n(d.amount)})`, `${en} (${d.source_doc_no}, ${n(d.amount)})`, d.source_doc_no, 'billing', { tranche_id: d.tranche_id, retention_id: d.retention_id, amount: n(d.amount), due_date: d.due_date, party_type: d.party_type });
      }
    }

    items.sort((a, b) => (SEV_RANK[a.severity]! - SEV_RANK[b.severity]!) || String(a.project_code ?? '').localeCompare(String(b.project_code ?? '')) || a.kind.localeCompare(b.kind));
    const by_kind: Record<string, number> = {};
    for (const it of items) by_kind[it.kind] = (by_kind[it.kind] ?? 0) + 1;
    const summary = {
      total: items.length,
      high: items.filter((i) => i.severity === 'high').length,
      medium: items.filter((i) => i.severity === 'medium').length,
      low: items.filter((i) => i.severity === 'low').length,
      by_kind,
    };
    return { as_of: today, stale_days: staleDays, summary, items };
  }

  // ── Forward resource & cash forecast (PMO-2) ─────────────────────────────
  // Makes the capacity calendar forward-looking: committed capacity demand per month, alongside a
  // BILLINGS/CASH forecast that overlays committed contractual billing with the probability-weighted pipeline —
  // "if we win the deals in the pipeline, when does the cash land (and where are we already over-allocated)?".
  // Read-only — rides PROJ-05 (resource governance) / PROJ-06 (EVM). Sources, all already in the system:
  //  • committed billing = Fixed-price pending MILESTONES with a billing_percent, dated in-horizon (× contract),
  //    plus each POC project's earned-but-unbilled contract asset (expected to invoice in the first month);
  //  • weighted pipeline = each OPEN opportunity's amount × probability%, placed at its expected close month;
  //  • committed demand = the resource capacity calendar's per-month allocation roll-up.
  async forecast(user: JwtUser, dto?: { months?: number; from?: string; rev_per_fte_month?: number }) {
    const db = this.db;
    const months = Math.max(1, Math.min(24, Math.round(dto?.months ?? 6)));
    const start = (dto?.from && /^\d{4}-\d{2}$/.test(dto.from)) ? dto.from : ymd().slice(0, 7);
    // Configurable value→FTE rate: the revenue one full-time-equivalent delivers per month — used to turn the
    // probability-weighted pipeline VALUE into projected resourcing DEMAND (FTE) so the forecast shows not just
    // "when does cash land" but "how many people would winning the pipeline need". Default if unset/invalid.
    const revPerFte = dto?.rev_per_fte_month != null && Number(dto.rev_per_fte_month) > 0 ? r2(dto.rev_per_fte_month) : DEFAULT_REV_PER_FTE_MONTH;
    const cap = await this.resourceCapacity(user, { months, from: start });
    const horizon: string[] = cap.horizon;
    const hset = new Set(horizon);
    const firstMonth = horizon[0];

    // Committed contractual billing per month.
    const committedBill = new Map<string, number>(horizon.map((m) => [m, 0]));
    const projRows = await db.select().from(projects).orderBy(desc(projects.id)).limit(200);
    const pById = new Map<number, any>(projRows.map((p: any) => [Number(p.id), p]));
    const ms = await db.select().from(projectMilestones).where(eq(projectMilestones.status, 'pending'));
    for (const m of ms) {
      if (m.billingPercent == null || !m.dueDate) continue;
      const mo = String(m.dueDate).slice(0, 7);
      if (!hset.has(mo)) continue;
      const proj = pById.get(Number(m.projectId)); if (!proj) continue;
      const bill = r2(n(proj.contractAmount) * n(m.billingPercent) / 100);
      if (bill > 0) committedBill.set(mo, r2((committedBill.get(mo) ?? 0) + bill));
    }
    // POC earned-but-unbilled (contract asset) is billable now → place in the first horizon month.
    let pocAsset = 0;
    for (const f of (await this.list(user)).projects) if (f.rev_method === 'poc' && (f.contract_asset ?? 0) > 0) pocAsset = r2(pocAsset + (f.contract_asset ?? 0));
    if (pocAsset > 0) committedBill.set(firstMonth!, r2((committedBill.get(firstMonth!) ?? 0) + pocAsset));

    // Probability-weighted pipeline per month (expected close).
    const weightedPipe = new Map<string, number>(horizon.map((m) => [m, 0]));
    const OPEN = ['prospecting', 'qualification', 'proposal', 'negotiation'];
    const opps = await db.select().from(crmOpportunities);
    let openCount = 0, openAmount = 0, weightedForecast = 0;
    for (const o of opps) {
      if (!OPEN.includes(o.stage)) continue;
      openCount++; openAmount = r2(openAmount + n(o.amount));
      const w = r2(n(o.amount) * Number(o.probability ?? 0) / 100);
      weightedForecast = r2(weightedForecast + w);
      const mo = o.expectedCloseDate ? String(o.expectedCloseDate).slice(0, 7) : null;
      if (mo && hset.has(mo)) weightedPipe.set(mo, r2((weightedPipe.get(mo) ?? 0) + w));
    }

    const billingMonthly = horizon.map((month) => {
      const committed = r2(committedBill.get(month) ?? 0);
      const weighted = r2(weightedPipe.get(month) ?? 0);
      return { month, committed_billing: committed, weighted_pipeline: weighted, total_expected: r2(committed + weighted) };
    });
    const committedTotal = r2(billingMonthly.reduce((s, m) => s + m.committed_billing, 0));
    const weightedTotal = r2(billingMonthly.reduce((s, m) => s + m.weighted_pipeline, 0));
    // Resourcing demand per month: committed (today's allocation, % → FTE) + the pipeline's projected FTE draw
    // (weighted pipeline value that month / rev_per_fte_month). total = committed + pipeline.
    const resourcingMonthly = cap.monthly.map((m: any) => {
      const committedFte = r2(m.total_demand_pct / 100);
      const pipelineFte = r2((weightedPipe.get(m.month) ?? 0) / revPerFte);
      return { month: m.month, committed_demand_pct: m.total_demand_pct, resources_over: m.resources_over, committed_demand_fte: committedFte, pipeline_demand_fte: pipelineFte, total_demand_fte: r2(committedFte + pipelineFte) };
    });
    const peakDemand = resourcingMonthly.reduce((mx: number, m: any) => Math.max(mx, m.committed_demand_pct), 0);
    const peakTotalFte = resourcingMonthly.reduce((mx: number, m: any) => Math.max(mx, m.total_demand_fte), 0);
    const pipelineFteTotal = r2(resourcingMonthly.reduce((s: number, m: any) => s + m.pipeline_demand_fte, 0));

    return {
      from: start, months, horizon, rev_per_fte_month: revPerFte,
      resourcing: { monthly: resourcingMonthly, over_allocated_count: cap.over_allocated_count, peak_demand_pct: r2(peakDemand), peak_total_demand_fte: r2(peakTotalFte), pipeline_demand_fte_total: pipelineFteTotal },
      billing: { monthly: billingMonthly, committed_total: committedTotal, weighted_pipeline_total: weightedTotal, expected_total: r2(committedTotal + weightedTotal) },
      pipeline: { open_count: openCount, open_amount: openAmount, weighted_forecast: weightedForecast },
    };
  }

  // ── Period governance / status pack (PMO-3) ──────────────────────────────
  // Assembles the recurring PMO status report so it isn't hand-built each period. For ONE project it returns
  // the full pack — header + EVM + the health-snapshot **trend** (PPM-4) + baseline variance (PROJ-07) +
  // open-HIGH risks (PROJ-08) + milestone status + the change-order log (PROJ-10); for the PORTFOLIO it
  // returns a RAG-ranked status row per project plus a roll-up. Read-only/detective — rides PROJ-06; also a
  // schedulable BI report type (`project_governance_pack`).
  async governancePack(user: JwtUser, opts?: { code?: string; period?: string }) {
    const period = opts?.period && /^\d{4}-\d{2}$/.test(opts.period) ? opts.period : ymd().slice(0, 7);
    if (opts?.code) return { scope: 'project', as_of: ymd(), period, project: await this.projectPack(opts.code, period, user) };
    const today = ymd();
    const ragRank: Record<string, number> = { red: 0, amber: 1, no_data: 2, green: 3 };
    const list = await this.list(user);
    const rows: any[] = [];
    const sum = { red: 0, amber: 0, green: 0, no_data: 0, unmitigated_high: 0, open_high_risks: 0, overdue_milestones: 0, pending_change_orders: 0 };
    for (const f of list.projects) {
      const code = f.project_code;
      const e = await this.evm(code);
      const rag = this.evmSvc.ragOf(e.cpi, e.spi);
      sum[rag as 'red' | 'amber' | 'green' | 'no_data']++;
      const risks = await this.listRisks(code);
      const ms = await this.listMilestones(code);
      const overdue = ms.milestones.filter((m: any) => m.status === 'pending' && m.due_date && String(m.due_date) < today).length;
      const co = await this.listChangeOrders(code);
      sum.unmitigated_high += risks.summary.unmitigated_high; sum.open_high_risks += risks.summary.high_open;
      sum.overdue_milestones += overdue; sum.pending_change_orders += co.summary.pending;
      rows.push({ project_code: code, name: f.name, status: f.status, rag, cpi: e.cpi, spi: e.spi, margin: f.margin, wip: f.wip,
        open_high_risks: risks.summary.high_open, unmitigated_high: risks.summary.unmitigated_high, overdue_milestones: overdue, pending_change_orders: co.summary.pending });
    }
    rows.sort((a, b) => (ragRank[a.rag]! - ragRank[b.rag]!) || String(a.project_code).localeCompare(String(b.project_code)));
    return { scope: 'portfolio', as_of: today, period, count: rows.length, summary: sum, projects: rows };
  }


  private async projectPack(code: string, period: string, user: JwtUser) {
    const today = ymd();
    const detail = await this.get(code);
    const e = await this.evm(code);
    const health = (await this.healthHistory(code)).history;
    const baseline = await this.getBaseline(code, user);
    const risks = await this.listRisks(code);
    const ms = await this.listMilestones(code);
    const co = await this.listChangeOrders(code);
    return {
      project_code: code, name: detail.name, status: detail.status, customer_name: detail.customer_name, period,
      rag: this.evmSvc.ragOf(e.cpi, e.spi), pct_complete: detail.pct_complete,
      contract_amount: detail.contract_amount, billed_to_date: detail.billed_to_date, wip: detail.wip, margin: detail.margin,
      evm: { cpi: e.cpi, spi: e.spi, bac: e.bac, ev: e.ev, ac: e.ac, eac: e.eac, cost_variance: e.cost_variance, schedule_variance: e.schedule_variance },
      health_trend: health,
      baseline: { active: baseline.baseline, variance: baseline.variance },
      risks: { summary: risks.summary, open_high: risks.risks.filter((r: any) => r.rag === 'red' && r.status !== 'closed') },
      milestones: {
        count: ms.count,
        overdue: ms.milestones.filter((m: any) => m.status === 'pending' && m.due_date && String(m.due_date) < today),
        reached: ms.milestones.filter((m: any) => m.status === 'reached').length,
        list: ms.milestones,
      },
      change_orders: { summary: co.summary, list: co.change_orders },
    };
  }




  // ── Change orders / contract variations (PROJ-10) ────────────────────────
  // Request a change order — a governed amendment to the contract value / budget / EAC. Posts/applies NOTHING;
  // it stays `pending` until a DIFFERENT user approves it (maker-checker), so a project can't move its
  // contract goalposts unilaterally.
  // ── Bill of Quantities (BoQ) — M0, docs/32 ────────────────────────────────
  // The project's measured-works requirement & budget baseline. A draft BoQ is authored with rate-built
  // lines (budget_amount = budget_qty × rate); an independent approver signs it off (maker-checker) — on
  // approval the project's budget_amount is synced to the sum of line budgets (the enforceable baseline that
  // M1's commitment ledger draws against). A locked BoQ is frozen. Line amount computed server-side.
  private boqLineAmount(dto: BoqLineDto) {
    return dto.budget_amount != null ? r2(dto.budget_amount) : r2(n(dto.budget_qty) * n(dto.rate));
  }

  async createBoq(code: string, dto: BoqDto, user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const boqNo = dto.boq_no?.trim() || `BOQ${String(Date.now()).slice(-8)}`;
    const [h] = await db.insert(projectBoq).values({
      projectId: Number(p.id), tenantId, boqNo, title: dto.title ?? null, status: 'draft', createdBy: user.username,
    }).returning({ id: projectBoq.id });
    const lines = dto.lines ?? [];
    for (let i = 0; i < lines.length; i++) {
      const it = lines[i]!;
      await db.insert(projectBoqLines).values({
        boqId: Number(h!.id), projectId: Number(p.id), tenantId, lineNo: i + 1,
        category: it.category ?? 'material', itemNo: it.item_no ?? null, taskId: it.task_id ?? null, wbsCode: it.wbs_code ?? null,
        description: it.description ?? null, uom: it.uom ?? null,
        budgetQty: fx(it.budget_qty ?? 0, 4), rate: fx(it.rate ?? 0, 2), budgetAmount: fx(this.boqLineAmount(it), 2),
      });
    }
    return this.getBoq(code);
  }

  // Latest BoQ for a project + its lines + budget rollup (total, by category, count).
  async getBoq(code: string) {
    const db = this.db;
    const p = await this.row(code);
    const [boq] = await db.select().from(projectBoq).where(eq(projectBoq.projectId, Number(p.id))).orderBy(desc(projectBoq.id)).limit(1);
    if (!boq) return { project_code: code, boq: null, lines: [], count: 0, budget_total: 0, by_category: {} };
    const lines = await db.select().from(projectBoqLines).where(eq(projectBoqLines.boqId, Number(boq.id))).orderBy(projectBoqLines.lineNo);
    const budgetTotal = r2(lines.reduce((s: number, l: any) => s + n(l.budgetAmount), 0));
    const byCategory: Record<string, number> = {};
    for (const l of lines) byCategory[l.category] = r2((byCategory[l.category] ?? 0) + n(l.budgetAmount));
    // M1 (PROJ-12) — per-line committed (open+consumed encumbrance) and remaining = budget − committed.
    const committedByLine = this.commitments ? await this.commitments.committedByLine(lines.map((l: any) => Number(l.id))) : new Map<number, number>();
    const shaped = lines.map((l: any) => {
      const committed = committedByLine.get(Number(l.id)) ?? 0;
      return { ...shapeBoqLine(l), committed, remaining: r2(n(l.budgetAmount) - committed) };
    });
    const committedTotal = r2(shaped.reduce((s: number, l: any) => s + n(l.committed), 0));
    return {
      project_code: code,
      boq: { id: Number(boq.id), boq_no: boq.boqNo, version: boq.version, title: boq.title, status: boq.status, budget_total: n(boq.budgetTotal), approved_by: boq.approvedBy, approved_at: boq.approvedAt, created_by: boq.createdBy },
      lines: shaped, count: lines.length, budget_total: budgetTotal,
      committed_total: committedTotal, remaining_total: r2(budgetTotal - committedTotal),
      by_category: byCategory,
    };
  }

  // Project site-cash (M4, docs/32, PROJ-14) — the advances, expense-reimbursement claims and petty-cash
  // requests raised AGAINST this project, so site cash is managed on the project. Read-only rollup.
  async siteCash(code: string) {
    const db = this.db;
    const p = await this.row(code);
    const pid = Number(p.id);
    const advances = await db.select().from(employeeAdvances).where(eq(employeeAdvances.projectId, pid)).orderBy(desc(employeeAdvances.id));
    const claims = await db.select().from(expenseClaims).where(eq(expenseClaims.projectId, pid)).orderBy(desc(expenseClaims.id));
    const petty = await db.select().from(expenseRequests).where(eq(expenseRequests.projectId, pid)).orderBy(desc(expenseRequests.id));
    const sum = (rows: any[]) => r2(rows.reduce((s: number, r: any) => s + n(r.amount), 0));
    const advTotal = sum(advances), claimTotal = sum(claims), pettyTotal = sum(petty);
    return {
      project_code: code,
      advances: advances.map((a: any) => ({ advance_no: a.advanceNo, payee: a.payee, amount: n(a.amount), status: a.status, settled_expense: n(a.settledExpense), issued_date: a.issuedDate })),
      reimbursements: claims.map((c: any) => ({ id: Number(c.id), category: c.category, amount: n(c.amount), status: c.status, entry_no: c.entryNo, ap_txn_no: c.apTxnNo, claim_date: c.claimDate })),
      petty_cash: petty.map((r: any) => ({ req_no: r.reqNo, kind: r.kind, payee: r.payee, amount: n(r.amount), status: r.status, gl_ref: r.glRef })),
      totals: { advances: advTotal, reimbursements: claimTotal, petty_cash: pettyTotal, total: r2(advTotal + claimTotal + pettyTotal) },
      count: advances.length + claims.length + petty.length,
    };
  }

  // Project commitments read model (M1, PROJ-12) — the encumbrance ledger for a project + a status summary.
  async listCommitments(code: string) {
    const p = await this.row(code);
    if (!this.commitments) return { project_code: code, commitments: [], count: 0, summary: { open: 0, consumed: 0, released: 0, committed: 0 } };
    return { project_code: code, ...(await this.commitments.listForProject(Number(p.id))) };
  }

  private async boqRow(boqId: number) {
    const [boq] = await this.db.select().from(projectBoq).where(eq(projectBoq.id, Number(boqId))).limit(1);
    if (!boq) throw new NotFoundException({ code: 'BOQ_NOT_FOUND', message: `BoQ ${boqId} not found`, messageTh: 'ไม่พบ BoQ' });
    return boq;
  }

  // Append a line to a DRAFT BoQ (an approved/locked BoQ is frozen — change it via a change order in M1+).
  async addBoqLine(boqId: number, dto: BoqLineDto, user: JwtUser) {
    const db = this.db;
    const boq = await this.boqRow(boqId);
    if (boq.status !== 'draft') throw new BadRequestException({ code: 'BOQ_NOT_DRAFT', message: `BoQ is ${boq.status}; only a draft BoQ accepts new lines`, messageTh: 'เพิ่มรายการได้เฉพาะ BoQ สถานะร่าง' });
    const [mx] = await db.select({ m: sql<string>`coalesce(max(${projectBoqLines.lineNo}),0)` }).from(projectBoqLines).where(eq(projectBoqLines.boqId, Number(boqId)));
    await db.insert(projectBoqLines).values({
      boqId: Number(boqId), projectId: Number(boq.projectId), tenantId: boq.tenantId ?? user.tenantId ?? null, lineNo: Number(mx?.m ?? 0) + 1,
      category: dto.category ?? 'material', itemNo: dto.item_no ?? null, taskId: dto.task_id ?? null, wbsCode: dto.wbs_code ?? null,
      description: dto.description ?? null, uom: dto.uom ?? null,
      budgetQty: fx(dto.budget_qty ?? 0, 4), rate: fx(dto.rate ?? 0, 2), budgetAmount: fx(this.boqLineAmount(dto), 2),
    });
    const [proj] = await db.select({ c: projects.projectCode }).from(projects).where(eq(projects.id, Number(boq.projectId))).limit(1);
    return this.getBoq(proj!.c);
  }

  // Approve a BoQ (maker-checker: approver ≠ author, SOD_SELF_APPROVAL). On approval the sum of line budgets
  // is snapshotted onto the BoQ and synced to the project's budget_amount — the enforceable material budget
  // baseline (M1's commitment ledger draws remaining = budget − actual − commitments against it).
  async approveBoq(boqId: number, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const boq = await this.boqRow(boqId);
    if (boq.status !== 'draft') throw new BadRequestException({ code: 'BOQ_NOT_DRAFT', message: `BoQ is already ${boq.status}`, messageTh: 'BoQ ถูกดำเนินการแล้ว' });
    await assertMakerChecker(db, { user, maker: boq.createdBy, event: 'proj.boq.approve', ref: String(boqId), reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve a BoQ you authored', messageTh: 'ผู้จัดทำ BoQ อนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)', httpStatus: 400 });
    const [tot] = await db.select({ v: sql<string>`coalesce(sum(${projectBoqLines.budgetAmount}),0)` }).from(projectBoqLines).where(eq(projectBoqLines.boqId, Number(boqId)));
    const budgetTotal = r2(n(tot?.v));
    await db.update(projectBoq).set({ status: 'approved', budgetTotal: fx(budgetTotal, 2), approvedBy: user.username, approvedAt: new Date() }).where(eq(projectBoq.id, Number(boqId)));
    // Sync the project's budget baseline to the approved BoQ total (the material/works budget).
    await db.update(projects).set({ budgetAmount: fx(budgetTotal, 2) }).where(eq(projects.id, Number(boq.projectId)));
    const [proj] = await db.select({ c: projects.projectCode }).from(projects).where(eq(projects.id, Number(boq.projectId))).limit(1);
    return { ...(await this.getBoq(proj!.c)), budget_synced: budgetTotal };
  }

  // Lock an approved BoQ — freeze it (no further re-measurement edits; the definitive baseline of record).
  async lockBoq(boqId: number, user: JwtUser) {
    const db = this.db;
    const boq = await this.boqRow(boqId);
    if (boq.status !== 'approved') throw new BadRequestException({ code: 'BOQ_NOT_APPROVED', message: `Only an approved BoQ can be locked (is ${boq.status})`, messageTh: 'ล็อกได้เฉพาะ BoQ ที่อนุมัติแล้ว' });
    await db.update(projectBoq).set({ status: 'locked' }).where(eq(projectBoq.id, Number(boqId)));
    const [proj] = await db.select({ c: projects.projectCode }).from(projects).where(eq(projects.id, Number(boq.projectId))).limit(1);
    return this.getBoq(proj!.c);
  }

  // Record the actual measured quantity for a line (re-measurement). Allowed while the BoQ is approved (not
  // yet locked); records remeasured_qty vs the budgeted qty — the basis for re-measurement variance.
  async remeasureBoqLine(lineId: number, dto: RemeasureDto, user: JwtUser) {
    const db = this.db;
    const [line] = await db.select().from(projectBoqLines).where(eq(projectBoqLines.id, Number(lineId))).limit(1);
    if (!line) throw new NotFoundException({ code: 'BOQ_LINE_NOT_FOUND', message: `BoQ line ${lineId} not found`, messageTh: 'ไม่พบรายการ BoQ' });
    const boq = await this.boqRow(Number(line.boqId));
    if (boq.status === 'draft') throw new BadRequestException({ code: 'BOQ_NOT_APPROVED', message: 'Re-measure an approved BoQ, not a draft', messageTh: 're-measure ได้เมื่อ BoQ อนุมัติแล้ว' });
    if (boq.status === 'locked') throw new BadRequestException({ code: 'BOQ_LOCKED', message: 'BoQ is locked — re-measurement is frozen', messageTh: 'BoQ ถูกล็อก แก้ไขไม่ได้' });
    await db.update(projectBoqLines).set({ remeasuredQty: fx(dto.remeasured_qty, 4) }).where(eq(projectBoqLines.id, Number(lineId)));
    const [proj] = await db.select({ c: projects.projectCode }).from(projects).where(eq(projects.id, Number(line.projectId))).limit(1);
    return this.getBoq(proj!.c);
  }

  async createChangeOrder(code: string, dto: ChangeOrderDto, user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    const contractDelta = r2(dto.contract_delta ?? 0), budgetDelta = r2(dto.budget_delta ?? 0), estDelta = r2(dto.estimated_cost_delta ?? 0);
    if (contractDelta === 0 && budgetDelta === 0 && estDelta === 0) throw new BadRequestException({ code: 'EMPTY_CHANGE_ORDER', message: 'A change order must change the contract, budget, or estimated cost', messageTh: 'ใบเปลี่ยนแปลงต้องเปลี่ยนมูลค่าสัญญา งบประมาณ หรือประมาณการต้นทุน' });
    const coNo = `CO${String(Date.now()).slice(-8)}`;
    await db.insert(projectChangeOrders).values({
      projectId: Number(p.id), tenantId: p.tenantId ?? user.tenantId ?? null, coNo, description: dto.description ?? null,
      contractDelta: fx(contractDelta, 2), budgetDelta: fx(budgetDelta, 2), estimatedCostDelta: fx(estDelta, 2),
      reason: dto.reason ?? null, status: 'pending', requestedBy: user.username,
    });
    return this.listChangeOrders(code);
  }

  // Approve a change order (maker-checker): the approver MUST differ from the requester (SOD_SELF_APPROVAL).
  // On approval the contract/budget/EAC deltas are applied to the project AND a new baseline is auto-captured
  // (reason = the CO), so the scope/contract change is authorised, segregated, and re-baselined (ties to PROJ-07).
  async approveChangeOrder(coId: number, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [co] = await db.select().from(projectChangeOrders).where(eq(projectChangeOrders.id, Number(coId))).limit(1);
    if (!co) throw new NotFoundException({ code: 'CHANGE_ORDER_NOT_FOUND', message: `Change order ${coId} not found`, messageTh: 'ไม่พบใบเปลี่ยนแปลง' });
    if (co.status !== 'pending') throw new BadRequestException({ code: 'CHANGE_ORDER_DECIDED', message: `Change order is already ${co.status}`, messageTh: 'ใบเปลี่ยนแปลงถูกตัดสินแล้ว' });
    await assertMakerChecker(db, { user, maker: co.requestedBy, event: 'proj.change-order.approve', ref: String(coId), reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve a change order you requested', messageTh: 'ผู้ขอเปลี่ยนแปลงอนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)', httpStatus: 400 });
    const [proj] = await db.select().from(projects).where(eq(projects.id, Number(co.projectId))).limit(1);
    const newContract = r2(Math.max(0, n(proj!.contractAmount) + n(co.contractDelta)));
    const newBudget = r2(Math.max(0, n(proj!.budgetAmount) + n(co.budgetDelta)));
    const newEst = r2(Math.max(0, n(proj!.estimatedCost) + n(co.estimatedCostDelta)));
    await db.update(projects).set({ contractAmount: fx(newContract, 2), budgetAmount: fx(newBudget, 2), estimatedCost: fx(newEst, 2) }).where(eq(projects.id, Number(proj!.id)));
    await db.update(projectChangeOrders).set({ status: 'approved', approvedBy: user.username, approvedAt: new Date() }).where(eq(projectChangeOrders.id, Number(coId)));
    // Re-baseline so the variance trail records the authorised change (PROJ-07). Best-effort.
    let baseline: any = null;
    try { baseline = await this.captureBaseline(proj!.projectCode, { label: `Change order ${co.coNo}`, reason: `Change order ${co.coNo}` }, user); } catch { /* baseline optional */ }
    return { change_order: co.coNo, project_code: proj!.projectCode, status: 'approved', contract_amount: newContract, budget_amount: newBudget, estimated_cost: newEst, baseline: baseline?.baseline ?? null };
  }

  async rejectChangeOrder(coId: number, user: JwtUser) {
    const db = this.db;
    const [co] = await db.select().from(projectChangeOrders).where(eq(projectChangeOrders.id, Number(coId))).limit(1);
    if (!co) throw new NotFoundException({ code: 'CHANGE_ORDER_NOT_FOUND', message: `Change order ${coId} not found`, messageTh: 'ไม่พบใบเปลี่ยนแปลง' });
    if (co.status !== 'pending') throw new BadRequestException({ code: 'CHANGE_ORDER_DECIDED', message: `Change order is already ${co.status}`, messageTh: 'ใบเปลี่ยนแปลงถูกตัดสินแล้ว' });
    const [proj] = await db.select().from(projects).where(eq(projects.id, Number(co.projectId))).limit(1);
    await db.update(projectChangeOrders).set({ status: 'rejected', approvedBy: user.username, approvedAt: new Date() }).where(eq(projectChangeOrders.id, Number(coId)));
    return this.listChangeOrders(proj!.projectCode);
  }

  async listChangeOrders(code: string) {
    const db = this.db;
    const p = await this.row(code);
    const rows = await db.select().from(projectChangeOrders).where(eq(projectChangeOrders.projectId, Number(p.id))).orderBy(desc(projectChangeOrders.id));
    const approved = rows.filter((r: any) => r.status === 'approved');
    return {
      project_code: code, change_orders: rows.map(shapeChangeOrder), count: rows.length,
      summary: {
        pending: rows.filter((r: any) => r.status === 'pending').length,
        approved: approved.length,
        approved_contract_delta: r2(approved.reduce((s: number, r: any) => s + n(r.contractDelta), 0)),
      },
    };
  }

  // ── Project templates (B2) ───────────────────────────────────────────────
  // Create a reusable WBS/milestone scaffold. Items default their seq to declaration order (1-based) so a
  // template can omit explicit seqs; parent_seq / depends_on_seq reference those ordinals.
  async createTemplate(dto: TemplateDto, user: JwtUser) {
    const db = this.db;
    const code = dto.code?.trim() || `TPL${String(Date.now()).slice(-6)}`;
    const [existing] = await db.select().from(projectTemplates).where(eq(projectTemplates.code, code)).limit(1);
    if (existing) throw new BadRequestException({ code: 'TEMPLATE_EXISTS', message: `Template ${code} already exists`, messageTh: 'รหัสแม่แบบซ้ำ' });
    const tenantId = user.tenantId ?? null;
    const [tpl] = await db.insert(projectTemplates).values({
      tenantId, code, name: dto.name, description: dto.description ?? null, status: 'active', createdBy: user.username,
    }).returning({ id: projectTemplates.id });
    const items = dto.items ?? [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      await db.insert(projectTemplateItems).values({
        templateId: Number(tpl!.id), tenantId, itemType: it!.item_type ?? 'task', seq: it!.seq ?? i + 1, name: it!.name,
        parentSeq: it!.parent_seq ?? null, wbsCode: it!.wbs_code ?? null,
        plannedHours: fx(it!.planned_hours ?? 0, 2), plannedCost: fx(it!.planned_cost ?? 0, 2),
        offsetStartDays: Math.round(n(it!.offset_start_days)), offsetEndDays: Math.round(n(it!.offset_end_days)),
        dependsOnSeq: depsCsv(it!.depends_on_seq),
        billingPercent: it!.billing_percent != null ? fx(it!.billing_percent, 2) : null,
        owner: it!.owner ?? null, assignee: it!.assignee ?? null,
      });
    }
    return this.getTemplate(code);
  }

  async listTemplates(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(projectTemplates).orderBy(desc(projectTemplates.id)).limit(200);
    const counts = await db.select({ tid: projectTemplateItems.templateId, c: sql<string>`count(*)` }).from(projectTemplateItems).groupBy(projectTemplateItems.templateId);
    const cBy = new Map<number, number>(counts.map((x: any) => [Number(x.tid), Number(x.c)]));
    return { templates: rows.map((t: any) => ({ id: Number(t.id), code: t.code, name: t.name, description: t.description, status: t.status, item_count: cBy.get(Number(t.id)) ?? 0, created_at: t.createdAt })), count: rows.length };
  }

  async getTemplate(code: string) {
    const db = this.db;
    const [tpl] = await db.select().from(projectTemplates).where(eq(projectTemplates.code, code)).limit(1);
    if (!tpl) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: `Template ${code} not found`, messageTh: 'ไม่พบแม่แบบ' });
    const items = await db.select().from(projectTemplateItems).where(eq(projectTemplateItems.templateId, Number(tpl.id))).orderBy(projectTemplateItems.seq);
    return {
      id: Number(tpl.id), code: tpl.code, name: tpl.name, description: tpl.description, status: tpl.status, created_at: tpl.createdAt,
      items: items.map(shapeTemplateItem), count: items.length,
    };
  }

  // Apply a template to a project: scaffold its task + milestone items in one step, dated relative to the
  // project start (the project's start_date, an explicit start_date override, or today). Tasks are created
  // first to map seq→id, then a second pass wires parent_id and depends_on; milestones are dated off the same
  // start. Idempotent-ish guard: refuses if the project already has tasks (so re-apply can't duplicate a WBS).
  async applyTemplate(code: string, tplCode: string, dto: ApplyTemplateDto, user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const [tpl] = await db.select().from(projectTemplates).where(eq(projectTemplates.code, tplCode)).limit(1);
    if (!tpl) throw new NotFoundException({ code: 'TEMPLATE_NOT_FOUND', message: `Template ${tplCode} not found`, messageTh: 'ไม่พบแม่แบบ' });
    const existing = await db.select({ id: projectTasks.id }).from(projectTasks).where(eq(projectTasks.projectId, Number(p.id))).limit(1);
    if (existing.length) throw new BadRequestException({ code: 'PROJECT_HAS_TASKS', message: 'Apply a template only to a project with no tasks yet', messageTh: 'ใช้แม่แบบได้เฉพาะโครงการที่ยังไม่มีงาน' });
    const items = await db.select().from(projectTemplateItems).where(eq(projectTemplateItems.templateId, Number(tpl.id))).orderBy(projectTemplateItems.seq);
    const start = dto.start_date ?? p.startDate ?? ymd();

    const taskItems = items.filter((it: any) => (it.itemType ?? 'task') !== 'milestone');
    const seqToId = new Map<number, number>();
    // Pass 1 — insert tasks, capturing seq→new id.
    for (const it of taskItems) {
      const [t] = await db.insert(projectTasks).values({
        projectId: Number(p.id), tenantId, parentId: null, wbsCode: it.wbsCode ?? null, name: it.name, status: 'open',
        plannedStart: addDays(start, n(it.offsetStartDays)), plannedEnd: addDays(start, n(it.offsetEndDays)),
        plannedHours: fx(n(it.plannedHours), 2), plannedCost: fx(n(it.plannedCost), 2), pctComplete: fx(0, 2),
        dependsOn: null, assignee: it.assignee ?? null, createdBy: user.username,
      }).returning({ id: projectTasks.id });
      seqToId.set(Number(it.seq), Number(t!.id));
    }
    // Pass 2 — wire parent_id + depends_on now that every seq has a real id.
    for (const it of taskItems) {
      const id = seqToId.get(Number(it.seq));
      if (id == null) continue;
      const set: any = {};
      if (it.parentSeq != null && seqToId.has(Number(it.parentSeq))) set.parentId = seqToId.get(Number(it.parentSeq));
      const deps = (it.dependsOnSeq ? String(it.dependsOnSeq).split(',') : [])
        .map((s: string) => seqToId.get(Number(s))).filter((x: any) => x != null);
      if (deps.length) set.dependsOn = deps.join(',');
      if (Object.keys(set).length) await db.update(projectTasks).set(set).where(eq(projectTasks.id, id));
    }
    // Milestones — dated off the same start (offset_end_days = due offset).
    const msItems = items.filter((it: any) => (it.itemType ?? 'task') === 'milestone');
    for (const it of msItems) {
      await db.insert(projectMilestones).values({
        projectId: Number(p.id), tenantId, name: it.name, dueDate: addDays(start, n(it.offsetEndDays)), owner: it.owner ?? null,
        status: 'pending', billingPercent: it.billingPercent != null ? fx(n(it.billingPercent), 2) : null, createdBy: user.username,
      });
    }
    return { ...(await this.listTasks(code)), template: tplCode, tasks_created: taskItems.length, milestones_created: msItems.length, start_date: start };
  }

  // ── Risk & issue register (B4, PROJ-08) ──────────────────────────────────
  // Log a risk (future threat) or issue (materialised problem). Score = prob×impact (risk) / 5×impact (issue);
  // RAG is derived from the score band. A HIGH (red) risk with no mitigation is the governance signal.
  async addRisk(code: string, dto: RiskDto, user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const kind = dto.kind === 'issue' ? 'issue' : 'risk';
    const impact = clamp15(dto.impact ?? 1);
    const probability = kind === 'issue' ? null : clamp15(dto.probability ?? 1);
    const score = riskScore(kind, probability, impact);
    await db.insert(projectRisks).values({
      projectId: Number(p.id), tenantId, kind, title: dto.title, status: 'open',
      probability, impact, score, rag: ragFor(score), owner: dto.owner ?? null,
      mitigation: dto.mitigation ?? null, dueDate: dto.due_date ?? null, createdBy: user.username,
    });
    // PMO-1: an open HIGH risk with no mitigation plan (PROJ-08 exposure) pushes to the action center.
    if (ragFor(score) === 'red' && !dto.mitigation) this.emitAction(tenantId, 'risk_unmitigated_high', 'high', code, { title: dto.title, score });
    return this.listRisks(code);
  }

  async listRisks(code: string) {
    const db = this.db;
    const p = await this.row(code);
    const rows = (await db.select().from(projectRisks).where(eq(projectRisks.projectId, Number(p.id))).orderBy(desc(projectRisks.score), desc(projectRisks.id))).map(shapeRisk);
    const open = rows.filter((r: any) => r.status !== 'closed');
    const high_open = open.filter((r: any) => r.rag === 'red');
    return {
      project_code: code, risks: rows, count: rows.length,
      summary: {
        open: open.length, closed: rows.length - open.length,
        risks: rows.filter((r: any) => r.kind === 'risk').length, issues: rows.filter((r: any) => r.kind === 'issue').length,
        high_open: high_open.length,
        // PROJ-08: open HIGH items with no mitigation plan — the unmitigated exposure that must be surfaced.
        unmitigated_high: high_open.filter((r: any) => !r.mitigation).length,
      },
    };
  }

  // Update a risk/issue: status (closing stamps closed_at), mitigation, owner, due, or a re-score (prob/impact →
  // score + rag recomputed). Returns the refreshed register.
  async patchRisk(riskId: number, dto: RiskPatchDto, user: JwtUser) {
    const db = this.db;
    const [r] = await db.select().from(projectRisks).where(eq(projectRisks.id, Number(riskId))).limit(1);
    if (!r) throw new NotFoundException({ code: 'RISK_NOT_FOUND', message: `Risk ${riskId} not found`, messageTh: 'ไม่พบความเสี่ยง' });
    const set: any = {};
    if (dto.title != null) set.title = dto.title;
    if (dto.owner != null) set.owner = dto.owner;
    if (dto.mitigation != null) set.mitigation = dto.mitigation;
    if (dto.due_date != null) set.dueDate = dto.due_date;
    if (dto.status != null) {
      set.status = dto.status;
      set.closedAt = dto.status === 'closed' ? new Date() : null;
    }
    if (dto.probability != null || dto.impact != null) {
      const impact = clamp15(dto.impact ?? r.impact);
      const probability = r.kind === 'issue' ? null : clamp15(dto.probability ?? r.probability ?? 1);
      const score = riskScore(r.kind, probability, impact);
      set.impact = impact; set.probability = probability; set.score = score; set.rag = ragFor(score);
    }
    await db.update(projectRisks).set(set).where(eq(projectRisks.id, Number(riskId)));
    const [proj] = await db.select().from(projects).where(eq(projects.id, Number(r.projectId))).limit(1);
    return this.listRisks(proj!.projectCode);
  }

  // Portfolio top-risks roll-up (Track A tie-in): every open risk/issue across the caller's projects, ranked by
  // score; `high` are the red (HIGH) ones and `unmitigated_high` the subset with no mitigation plan (PROJ-08).
  async topRisks(user: JwtUser) {
    const db = this.db;
    const rows = (await db.select().from(projectRisks).where(sql`${projectRisks.status} <> 'closed'`)).map(shapeRisk);
    const projRows = await db.select().from(projects);
    const pById = new Map<number, any>(projRows.map((p: any) => [Number(p.id), p]));
    const enriched = rows
      .map((r: any) => ({ ...r, project_code: pById.get(r.project_id)?.projectCode ?? null, project_name: pById.get(r.project_id)?.name ?? null }))
      .sort((a: any, b: any) => b.score - a.score);
    const high = enriched.filter((r: any) => r.rag === 'red');
    return {
      as_of: ymd(), open_count: enriched.length, high_count: high.length,
      unmitigated_high_count: high.filter((r: any) => !r.mitigation).length,
      top: enriched.slice(0, 20),
    };
  }





  private async row(code: string) {
    const [p] = await this.db.select().from(projects).where(eq(projects.projectCode, code)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${code} not found`, messageTh: 'ไม่พบโครงการ' });
    return p;
  }

  private fmt(p: any, nonBillable = 0) {
    const cost = n(p.costToDate), recognized = n(p.recognizedCost), billed = n(p.billedToDate), nb = r2(nonBillable);
    const budget = n(p.budgetAmount), totalCost = r2(cost + nb);
    // POC (PROJ-09): revenue is recognised over time → margin/recognised-revenue come from recognized_revenue,
    // and the unbilled-vs-overbilled position surfaces as contract asset (1265) / liability (2410).
    const isPoc = p.revMethod === 'poc';
    const recognizedRevenue = n(p.recognizedRevenue);
    const recognizedRev = isPoc ? recognizedRevenue : billed; // billing-method recognises revenue at billing
    return {
      project_code: p.projectCode, name: p.name, customer_name: p.customerName, customer_no: p.customerNo, crm_opp_no: p.crmOppNo, billing_type: p.billingType, status: p.status,
      rev_method: p.revMethod, estimated_cost: n(p.estimatedCost),
      budget_amount: budget, budget_tolerance_pct: n(p.budgetTolerancePct), contract_amount: n(p.contractAmount),
      cost_to_date: cost, recognized_cost: recognized, recognized_revenue: recognizedRevenue, billed_to_date: billed,
      non_billable_cost: nb,                       // expensed straight to 5800 (unrecoverable)
      total_cost: totalCost,                       // all costs incurred (recoverable WIP + non-billable)
      // Budget control: variance = budget − total cost incurred (negative = OVER budget); budget_used_pct +
      // over_budget flag let the controller catch a cost overrun before it eats the margin (null if no budget).
      budget_variance: budget > 0 ? r2(budget - totalCost) : null,
      budget_used_pct: budget > 0 ? r2((totalCost / budget) * 100) : null,
      over_budget: budget > 0 && totalCost > budget,
      wip: r2(cost - recognized),                  // unbilled BILLABLE cost sitting in 1260
      margin: r2(recognizedRev - recognized - nb), // recognised revenue − recognised billable cost − absorbed non-billable
      // POC over-time position: cost-to-cost %, the contract asset (earned but unbilled) / liability (billed in excess).
      poc_pct: isPoc ? (n(p.estimatedCost) > 0 || budget > 0 ? r2(Math.min(100, (cost / (n(p.estimatedCost) > 0 ? n(p.estimatedCost) : budget)) * 100)) : null) : null,
      contract_asset: isPoc ? r2(Math.max(0, recognizedRevenue - billed)) : null,
      billings_in_excess: isPoc ? r2(Math.max(0, billed - recognizedRevenue)) : null,
      // Fixed-price progress: how much of the contract is billed + what's left to bill (null for T&M).
      billed_pct: p.billingType === 'Fixed' && n(p.contractAmount) > 0 ? r2((billed / n(p.contractAmount)) * 100) : null,
      remaining_to_bill: p.billingType === 'Fixed' && n(p.contractAmount) > 0 ? r2(Math.max(0, n(p.contractAmount) - billed)) : null,
      start_date: p.startDate, end_date: p.endDate, created_at: p.createdAt,
      // Program (cross-project) scheduling (PMO-4).
      program_code: p.programCode ?? null, depends_on_projects: csvToList(p.dependsOnProjects),
    };
  }

  // ───────────────── PROJ-03 — period-end project-close WIP/clearing review + sign-off ─────────────────
  // Snapshot unbilled-WIP (GL 1260) + the applied-costs clearing balance (GL 2390) + open-project count.
  private async closeSnapshot() {
    const db = this.db;
    const [wip] = await db.select({ v: sql<string>`coalesce(sum(${journalLines.debit}) - sum(${journalLines.credit}),0)` })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalLines.accountCode, '1260'), eq(journalEntries.status, 'Posted')));
    const [clr] = await db.select({ v: sql<string>`coalesce(sum(${journalLines.credit}) - sum(${journalLines.debit}),0)` })
      .from(journalLines).innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalLines.accountCode, '2390'), eq(journalEntries.status, 'Posted')));
    const [op] = await db.select({ c: sql<string>`count(*)` }).from(projects).where(sql`${projects.status} not in ('Closed','Completed','Cancelled')`);
    return { wipTotal: r2(n(wip?.v)), clearingBalance: r2(n(clr?.v)), openProjects: Number(op?.c ?? 0) };
  }

  // Preparer: snapshot + sign the period's WIP/clearing review (upsert per tenant/period; a prior
  // Rejected/Prepared is refreshed). A control account that gets reviewed at close (PROJ-03, detective).
  async prepareCloseReview(period: string, user: JwtUser) {
    if (!/^\d{4}-\d{2}$/.test(period)) throw new BadRequestException({ code: 'BAD_PERIOD', message: 'period must be YYYY-MM', messageTh: 'งวดต้องเป็น YYYY-MM' });
    const db = this.db;
    const snap = await this.closeSnapshot();
    const [existing] = await db.select().from(projectCloseReviews).where(and(eq(projectCloseReviews.tenantId, user.tenantId!), eq(projectCloseReviews.period, period))).limit(1);
    if (existing?.status === 'Approved') throw new BadRequestException({ code: 'ALREADY_APPROVED', message: `Project close review for ${period} is already approved`, messageTh: 'งวดนี้อนุมัติแล้ว' });
    const values: any = {
      tenantId: user.tenantId ?? null, period, status: 'Prepared',
      wipTotal: String(snap.wipTotal), clearingBalance: String(snap.clearingBalance), openProjects: snap.openProjects,
      preparedBy: user.username, preparedAt: new Date(), approvedBy: null, approvedAt: null, rejectionReason: null,
    };
    if (existing) await db.update(projectCloseReviews).set(values).where(eq(projectCloseReviews.id, existing.id));
    else await db.insert(projectCloseReviews).values(values);
    return this.getCloseReview(period, user);
  }

  // Checker: sign off (SoD — approver ≠ preparer). Detective review, so no hard numeric gate; the independent
  // sign-off IS the control.
  async approveCloseReview(period: string, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [rp] = await db.select().from(projectCloseReviews).where(and(eq(projectCloseReviews.tenantId, user.tenantId!), eq(projectCloseReviews.period, period))).limit(1);
    if (!rp) throw new NotFoundException({ code: 'NOT_PREPARED', message: `Project close review for ${period} has not been prepared`, messageTh: 'ยังไม่ได้จัดทำการสอบทาน' });
    if (rp.status !== 'Prepared') throw new BadRequestException({ code: 'NOT_PREPARED', message: `Project close review is ${rp.status}, not Prepared`, messageTh: 'สถานะไม่ใช่ Prepared' });
    await assertMakerChecker(db, { user, maker: rp.preparedBy, event: 'proj.close-review.approve', ref: period, reason: selfApprovalReason, code: 'SOD_VIOLATION', message: 'Maker-checker: the approver must differ from the preparer', messageTh: 'ผู้อนุมัติต้องไม่ใช่ผู้จัดทำ (แบ่งแยกหน้าที่)' });
    await db.update(projectCloseReviews).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() }).where(eq(projectCloseReviews.id, rp.id));
    return this.getCloseReview(period, user);
  }

  async rejectCloseReview(period: string, reason: string, user: JwtUser) {
    const db = this.db;
    const [rp] = await db.select().from(projectCloseReviews).where(and(eq(projectCloseReviews.tenantId, user.tenantId!), eq(projectCloseReviews.period, period))).limit(1);
    if (!rp) throw new NotFoundException({ code: 'NOT_PREPARED', message: 'Project close review has not been prepared', messageTh: 'ยังไม่ได้จัดทำ' });
    if (rp.status !== 'Prepared') throw new BadRequestException({ code: 'NOT_PREPARED', message: `Project close review is ${rp.status}, not Prepared`, messageTh: 'สถานะไม่ใช่ Prepared' });
    await db.update(projectCloseReviews).set({ status: 'Rejected', rejectionReason: reason ?? null }).where(eq(projectCloseReviews.id, rp.id));
    return this.getCloseReview(period, user);
  }

  async getCloseReview(period: string, user: JwtUser) {
    const db = this.db;
    const [rp] = await db.select().from(projectCloseReviews).where(and(eq(projectCloseReviews.tenantId, user.tenantId!), eq(projectCloseReviews.period, period))).limit(1);
    if (!rp) return { period, status: 'None' };
    return this.shapeCloseReview(rp);
  }

  async listCloseReviews(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(projectCloseReviews).where(user.tenantId != null ? eq(projectCloseReviews.tenantId, user.tenantId) : undefined).orderBy(desc(projectCloseReviews.period)).limit(60);
    return { reviews: rows.map((r: any) => this.shapeCloseReview(r)), count: rows.length };
  }

  private shapeCloseReview(r: any) {
    return {
      period: r.period, status: r.status, wip_total: n(r.wipTotal), clearing_balance: n(r.clearingBalance), open_projects: Number(r.openProjects ?? 0),
      prepared_by: r.preparedBy, prepared_at: r.preparedAt, approved_by: r.approvedBy, approved_at: r.approvedAt, rejection_reason: r.rejectionReason,
    };
  }
}

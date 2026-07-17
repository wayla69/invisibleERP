import { Inject, Injectable, Optional, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projects, projectEntries, projectTasks, projectBoq, crmOpportunities, customerMaster } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { postingDefault } from '../ledger/posting-events';
import { BiLiveService } from '../bi/bi-live.service';
import { CommitmentsService } from '../commitments/commitments.service';
import { RetentionService } from '../retention/retention.service';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { ProjectsResourcingService } from './projects-resourcing.service';
import { ProjectsWbsService } from './projects-wbs.service';
import { ProjectsEvmService } from './projects-evm.service';
import { ProjectsMaterialService } from './projects-material.service';
import { BoqImportService, type BoqImportInput } from './boq-import.service';
import { ProjectsPortfolioService } from './projects-portfolio.service';
import { ProjectsGateService } from './projects-gate.service';
import { ProgramBenefitsService } from './program-benefits.service';
import { ProjectsBoqService } from './projects-boq.service';
import { ProjectsTemplatesService } from './projects-templates.service';
import { ProjectsRiskService } from './projects-risk.service';
import { ProjectsCloseService } from './projects-close.service';
import { LedgerReadService } from '../ledger/ledger-read.service';
import { ProjectsPmoService } from './projects-pmo.service';
import { r2, csvToList } from './projects.helpers';


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
  private readonly materialSvc: ProjectsMaterialService;
  private readonly boqImportSvc: BoqImportService;
  private readonly portfolio: ProjectsPortfolioService;
  private readonly gates: ProjectsGateService;
  private readonly benefits: ProgramBenefitsService;
  private readonly boq: ProjectsBoqService;
  private readonly templates: ProjectsTemplatesService;
  private readonly risks: ProjectsRiskService;
  private readonly closeReview: ProjectsCloseService;
  private readonly pmo: ProjectsPmoService;

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
    // A3 (docs/50 Wave 3) — material control tower read models (ctor-body plain class, ratchet pattern).
    // A5 (docs/50 Wave 5) — + the facade evm() port for the EVM-by-category lens.
    this.materialSvc = new ProjectsMaterialService(db, (code) => this.row(code), this.commitments, (code) => this.evm(code));
    // A4 (docs/50 Wave 4) — BoQ takeoff import (ctor-body plain class, ratchet pattern).
    this.boqImportSvc = new BoqImportService(db, (code) => this.row(code), (code) => this.getBoq(code));
    this.portfolio = new ProjectsPortfolioService(db);
    this.gates = new ProjectsGateService(db, (code) => this.row(code));
    this.benefits = new ProgramBenefitsService(db);
    // docs/46 Phase-4 projects round: four more ctor-body sub-services. CO approval re-baselines through the
    // facade's captureBaseline delegator (→ evmSvc); template apply returns via the WBS listTasks delegator;
    // the close review reads GL 1260/2390 through a locally-constructed LedgerReadService (kept out of DI so
    // the goldenmaster's positional (db, ledger) construction stays valid).
    this.boq = new ProjectsBoqService(db, (code) => this.row(code), (c, d, u) => this.captureBaseline(c, d, u), this.commitments);
    this.templates = new ProjectsTemplatesService(db, (code) => this.row(code), (code) => this.listTasks(code));
    this.risks = new ProjectsRiskService(db, (code) => this.row(code), (t, k, sev, c, x) => this.emitAction(t, k, sev, c, x));
    this.closeReview = new ProjectsCloseService(db, new LedgerReadService(db));
    // docs/46 round 5 — the read-only PMO command-center aggregators (portfolio EVM / action center /
    // forecast / governance pack / resource leveling) compose across the sub-services THROUGH the facade's
    // delegators, so the ports simply loop back into `this`.
    this.pmo = new ProjectsPmoService(db, {
      row: (code) => this.row(code),
      list: (user) => this.list(user),
      get: (code) => this.get(code),
      evm: (code, asOf) => this.evm(code, asOf),
      schedule: (code) => this.schedule(code),
      earnedSchedule: (code, asOf) => this.earnedSchedule(code, asOf),
      evmByCategory: (code) => this.evmByCategory(code),
      healthHistory: (code) => this.healthHistory(code),
      getBaseline: (code, user) => this.getBaseline(code, user),
      listRisks: (code) => this.listRisks(code),
      listMilestones: (code) => this.listMilestones(code),
      listChangeOrders: (code) => this.listChangeOrders(code),
      topRisks: (user) => this.topRisks(user),
      resourceUtilization: (user) => this.resourceUtilization(user),
      resourceCapacity: (user, dto) => this.resourceCapacity(user, dto),
      ragOf: (cpi, spi) => this.evmSvc.ragOf(cpi, spi),
    }, this.retention);
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
  // A3 (docs/50 Wave 3) — thin delegators; logic in projects-material.service.ts (ratchet).
  async boqByWbs(code: string) { return this.materialSvc.boqByWbs(code); }
  async materialDrawCurve(code: string) { return this.materialSvc.drawCurve(code); }
  async evmByCategory(code: string) { return this.materialSvc.evmByCategory(code); } // A5 (docs/50 Wave 5)
  // A4 (docs/50 Wave 4) — thin delegators; logic in boq-import.service.ts (ratchet).
  async importBoq(code: string, input: BoqImportInput, user: JwtUser) { return this.boqImportSvc.importBoq(code, input, user); }
  boqImportTemplate() { return this.boqImportSvc.template(); }
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

  // ── PMO command-center aggregators (docs/46 round 5) — ProjectsPmoService; thin delegators. ──
  // Resource leveling (PPM-A2, PROJ-23), portfolio command center (A1), action center (PMO-1, PROJ-11),
  // forward resource & cash forecast (PMO-2), period governance pack (PMO-3, incl. the per-project pack).
  async resourceLeveling(code: string, user: JwtUser) { return this.pmo.resourceLeveling(code, user); }
  async portfolioEvm(user: JwtUser) { return this.pmo.portfolioEvm(user); }
  async actionCenter(user: JwtUser, dto?: { stale_days?: number }) { return this.pmo.actionCenter(user, dto); }
  async forecast(user: JwtUser, dto?: { months?: number; from?: string; rev_per_fte_month?: number }) { return this.pmo.forecast(user, dto); }
  async governancePack(user: JwtUser, opts?: { code?: string; period?: string }) { return this.pmo.governancePack(user, opts); }

  // ── BoQ / change orders / site cash (docs/32 M0–M4, PROJ-10/12/14) — ProjectsBoqService ──
  async createBoq(code: string, dto: BoqDto, user: JwtUser) { return this.boq.createBoq(code, dto, user); }
  async getBoq(code: string) { return this.boq.getBoq(code); }
  async siteCash(code: string) { return this.boq.siteCash(code); }
  async listCommitments(code: string) { return this.boq.listCommitments(code); }
  async addBoqLine(boqId: number, dto: BoqLineDto, user: JwtUser) { return this.boq.addBoqLine(boqId, dto, user); }
  async approveBoq(boqId: number, user: JwtUser, selfApprovalReason?: string | null) { return this.boq.approveBoq(boqId, user, selfApprovalReason); }
  async lockBoq(boqId: number, user: JwtUser) { return this.boq.lockBoq(boqId, user); }
  async remeasureBoqLine(lineId: number, dto: RemeasureDto, user: JwtUser) { return this.boq.remeasureBoqLine(lineId, dto, user); }
  async createChangeOrder(code: string, dto: ChangeOrderDto, user: JwtUser) { return this.boq.createChangeOrder(code, dto, user); }
  async approveChangeOrder(coId: number, user: JwtUser, selfApprovalReason?: string | null) { return this.boq.approveChangeOrder(coId, user, selfApprovalReason); }
  async rejectChangeOrder(coId: number, user: JwtUser) { return this.boq.rejectChangeOrder(coId, user); }
  async listChangeOrders(code: string) { return this.boq.listChangeOrders(code); }

  // ── Project templates (B2) — ProjectsTemplatesService ───────────────────
  async createTemplate(dto: TemplateDto, user: JwtUser) { return this.templates.createTemplate(dto, user); }
  async listTemplates(user: JwtUser) { return this.templates.listTemplates(user); }
  async getTemplate(code: string) { return this.templates.getTemplate(code); }
  async applyTemplate(code: string, tplCode: string, dto: ApplyTemplateDto, user: JwtUser) { return this.templates.applyTemplate(code, tplCode, dto, user); }

  // ── Risk & issue register (B4, PROJ-08) — ProjectsRiskService ────────────
  async addRisk(code: string, dto: RiskDto, user: JwtUser) { return this.risks.addRisk(code, dto, user); }
  async listRisks(code: string) { return this.risks.listRisks(code); }
  async patchRisk(riskId: number, dto: RiskPatchDto, user: JwtUser) { return this.risks.patchRisk(riskId, dto, user); }
  async topRisks(user: JwtUser) { return this.risks.topRisks(user); }





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
  // Extracted to ProjectsCloseService (docs/46 Phase-4 projects round); GL 1260/2390 snapshots go through
  // LedgerReadService there, so this facade no longer touches the journal tables.
  async prepareCloseReview(period: string, user: JwtUser) { return this.closeReview.prepareCloseReview(period, user); }
  async approveCloseReview(period: string, user: JwtUser, selfApprovalReason?: string | null) { return this.closeReview.approveCloseReview(period, user, selfApprovalReason); }
  async rejectCloseReview(period: string, reason: string, user: JwtUser) { return this.closeReview.rejectCloseReview(period, reason, user); }
  async getCloseReview(period: string, user: JwtUser) { return this.closeReview.getCloseReview(period, user); }
  async listCloseReviews(user: JwtUser) { return this.closeReview.listCloseReviews(user); }
}

import { Inject, Injectable, Optional, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projects, projectEntries, projectTasks, projectMilestones, projectResources, resourceRates, projectBaselines, projectTemplates, projectTemplateItems, projectRisks, projectChangeOrders, projectHealthSnapshots, projectCloseReviews, projectBoq, projectBoqLines, projectMaterialRequisitions, crmOpportunities, customerMaster, timesheets, journalEntries, journalLines } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { BiLiveService } from '../bi/bi-live.service';
import { CommitmentsService } from '../commitments/commitments.service';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
// Default value→FTE rate (PMO-5): the revenue one full-time-equivalent delivers per month. Used to convert
// the probability-weighted pipeline VALUE into projected resourcing DEMAND (FTE). Overridable per request.
const DEFAULT_REV_PER_FTE_MONTH = 200000;
const r4 = (x: unknown) => Math.round((Number(x) || 0) * 10000) / 10000;
const clampPct = (x: unknown) => Math.max(0, Math.min(100, r2(x)));
const depsCsv = (ids?: number[]) => (ids && ids.length ? ids.map((i) => Number(i)).filter((i) => Number.isFinite(i)).join(',') : null);
// People CSV (RACI lists) — trim, drop blanks/dupes; null when empty so an omitted field clears nothing.
const peopleCsv = (xs?: string[]) => {
  if (xs == null) return undefined; // not provided → leave column untouched
  const u = [...new Set(xs.map((x) => String(x).trim()).filter(Boolean))];
  return u.length ? u.join(',') : null;
};
const csvToList = (s: unknown) => (s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : []);

export interface CreateProjectDto { project_code?: string; name: string; customer_name?: string; customer_no?: string; billing_type?: 'TM' | 'Fixed'; budget_amount?: number; contract_amount?: number; start_date?: string; end_date?: string; rev_method?: 'billing' | 'poc'; estimated_cost?: number }
export interface RecognizeDto { as_of?: string; estimated_cost?: number }
export interface ChangeOrderDto { description?: string; contract_delta?: number; budget_delta?: number; estimated_cost_delta?: number; reason?: string }
export interface CostDto { entry_type?: 'time' | 'expense'; description?: string; qty?: number; rate?: number; amount?: number; billable?: boolean; entry_date?: string }
export interface BillDto { amount?: number; percent?: number }
export interface FromOpportunityDto { project_code?: string; billing_type?: 'TM' | 'Fixed'; budget_amount?: number; start_date?: string; end_date?: string }
export interface TaskDto { name: string; parent_id?: number; wbs_code?: string; status?: string; planned_start?: string; planned_end?: string; planned_hours?: number; planned_cost?: number; pct_complete?: number; assignee?: string; depends_on?: number[]; accountable?: string; responsible?: string[]; consulted?: string[]; informed?: string[] }
export interface TaskPatchDto { name?: string; status?: string; planned_start?: string; planned_end?: string; planned_hours?: number; planned_cost?: number; pct_complete?: number; assignee?: string; depends_on?: number[]; accountable?: string; responsible?: string[]; consulted?: string[]; informed?: string[] }
export interface MilestoneDto { name: string; due_date?: string; owner?: string; billing_percent?: number }
export interface RateCardDto { role: string; cost_rate?: number; bill_rate?: number; effective_from?: string; effective_to?: string }
export interface ResourceDto { resource_name: string; role?: string; task_id?: number; alloc_pct?: number; period_start?: string; period_end?: string }
export interface BaselineDto { label?: string; reason?: string }
export interface ProgramDto { program_code?: string | null; depends_on_projects?: string[] }
export interface TemplateItemDto { item_type?: 'task' | 'milestone'; seq?: number; name: string; parent_seq?: number; wbs_code?: string; planned_hours?: number; planned_cost?: number; offset_start_days?: number; offset_end_days?: number; depends_on_seq?: number[]; billing_percent?: number; owner?: string; assignee?: string }
export interface TemplateDto { code?: string; name: string; description?: string; items?: TemplateItemDto[] }
export interface ApplyTemplateDto { start_date?: string }
export interface BoqLineDto { category?: 'material' | 'labor' | 'subcon' | 'other'; item_no?: string; task_id?: number; wbs_code?: string; description?: string; uom?: string; budget_qty?: number; rate?: number; budget_amount?: number }
export interface BoqDto { title?: string; boq_no?: string; lines?: BoqLineDto[] }
export interface RemeasureDto { remeasured_qty: number }
export interface RiskDto { kind?: 'risk' | 'issue'; title: string; probability?: number; impact?: number; owner?: string; mitigation?: string; due_date?: string }
export interface RiskPatchDto { status?: 'open' | 'mitigating' | 'closed'; probability?: number; impact?: number; owner?: string; mitigation?: string; due_date?: string; title?: string }

// Risk scoring (1..25): a risk is probability × impact; an issue has already occurred (probability = 5/certain)
// so it scores 5 × impact. RAG follows the score band — red ≥ 12 (HIGH), amber ≥ 6, else green.
const clamp15 = (x: unknown) => Math.max(1, Math.min(5, Math.round(Number(x) || 1)));
const riskScore = (kind: string, prob: number | null, impact: number) => (kind === 'issue' ? 5 : (prob ?? 1)) * impact;
const ragFor = (score: number) => (score >= 12 ? 'red' : score >= 6 ? 'amber' : 'green');

// Add whole days to a yyyy-mm-dd date string (UTC date arithmetic — date-only, no TZ drift).
const addDays = (ymdStr: string, days: number) => {
  const d = new Date(`${ymdStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
};

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
    // Optional so partial harnesses (and any consumer that constructs the service without the bus) still
    // build; when present, the action center pushes a `project_action` SSE event on red/unmitigated-high.
    @Optional() private readonly live?: BiLiveService,
    // M1 (PROJ-12) — the BoQ-line encumbrance ledger; when present, getBoq shows budget/committed/remaining
    // per line and listCommitments exposes the project commitments. @Optional so partial harnesses still build.
    @Optional() private readonly commitments?: CommitmentsService,
  ) {}

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
      revMethod, estimatedCost: fx(dto.estimated_cost ?? 0, 2),
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
    const je: any = await this.ledger.postEntry({
      source: 'PRJ-COST', sourceRef: `${code}:${Number(e!.id)}`, tenantId, memo: `Project cost ${code}${billable ? '' : ' (non-billable)'}`, createdBy: user.username,
      lines: billable
        ? [{ account_code: '1260', debit: amount, memo: `WIP ${code}` }, { account_code: '2390', credit: amount, memo: conv }]
        : [{ account_code: '5800', debit: amount, memo: `Non-billable cost ${code}` }, { account_code: '2390', credit: amount, memo: conv }],
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
    const lines = [
      { account_code: '1100', debit: bill, memo: `AR ${code}` },
      { account_code: '4200', credit: bill, memo: 'Project revenue' },
    ];
    if (relieve > 0) {
      lines.push({ account_code: '5800', debit: relieve, memo: 'Project cost of services' });
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

    const lines: any[] = [];
    if (periodRevenue > 0.005) {
      // Recognise revenue: first reverse any billings-in-excess (2410), the remainder builds the contract asset (1265).
      const liability = r2(Math.max(0, n(p.billedToDate) - n(p.recognizedRevenue)));
      const fromLiability = r2(Math.min(periodRevenue, liability));
      const toAsset = r2(periodRevenue - fromLiability);
      if (fromLiability > 0) lines.push({ account_code: '2410', debit: fromLiability, memo: `Release billings in excess ${code}` });
      if (toAsset > 0) lines.push({ account_code: '1265', debit: toAsset, memo: `Contract asset ${code}` });
      lines.push({ account_code: '4200', credit: periodRevenue, memo: `Project revenue (POC ${pocPct}%)` });
    }
    if (periodCost > 0.005) {
      lines.push({ account_code: '5800', debit: periodCost, memo: 'Project cost of services' });
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
      pct_complete: this.taskRollup(tasks),
      task_count: tasks.length,
      boq: boq ? { id: Number(boq.id), boq_no: boq.boqNo, status: boq.status, budget_total: n(boq.budgetTotal) } : null,
      entries: entries.map((e: any) => ({ entry_type: e.entryType, description: e.description, qty: n(e.qty), rate: n(e.rate), amount: n(e.amount), billable: e.billable !== false, entry_date: e.entryDate, entry_no: e.entryNo })),
    };
  }

  // ── WBS tasks (P1) ───────────────────────────────────────────────────────
  async addTask(code: string, dto: TaskDto, user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const [t] = await db.insert(projectTasks).values({
      projectId: Number(p.id), tenantId, parentId: dto.parent_id ?? null, wbsCode: dto.wbs_code ?? null, name: dto.name,
      status: dto.status ?? 'open', plannedStart: dto.planned_start ?? null, plannedEnd: dto.planned_end ?? null,
      plannedHours: fx(dto.planned_hours ?? 0, 2), plannedCost: fx(dto.planned_cost ?? 0, 2),
      pctComplete: fx(clampPct(dto.pct_complete ?? 0), 2), dependsOn: depsCsv(dto.depends_on), assignee: dto.assignee ?? null,
      accountable: dto.accountable ?? null, responsible: peopleCsv(dto.responsible) ?? null, consulted: peopleCsv(dto.consulted) ?? null, informed: peopleCsv(dto.informed) ?? null,
      createdBy: user.username,
    }).returning({ id: projectTasks.id });
    return this.listTasks(code);
  }

  async listTasks(code: string) {
    const db = this.db;
    const p = await this.row(code);
    const rows = await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id))).orderBy(projectTasks.id);
    return { project_code: code, pct_complete: this.taskRollup(rows), tasks: rows.map(shapeTask), count: rows.length };
  }

  async patchTask(taskId: number, dto: TaskPatchDto, user: JwtUser) {
    const db = this.db;
    const [t] = await db.select().from(projectTasks).where(eq(projectTasks.id, Number(taskId))).limit(1);
    if (!t) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: `Task ${taskId} not found`, messageTh: 'ไม่พบงาน' });
    const set: any = {};
    if (dto.name != null) set.name = dto.name;
    if (dto.status != null) set.status = dto.status;
    if (dto.planned_start != null) set.plannedStart = dto.planned_start;
    if (dto.planned_end != null) set.plannedEnd = dto.planned_end;
    if (dto.planned_hours != null) set.plannedHours = fx(dto.planned_hours, 2);
    if (dto.planned_cost != null) set.plannedCost = fx(dto.planned_cost, 2);
    if (dto.assignee != null) set.assignee = dto.assignee;
    if (dto.accountable != null) set.accountable = dto.accountable || null;
    if (dto.responsible != null) set.responsible = peopleCsv(dto.responsible);
    if (dto.consulted != null) set.consulted = peopleCsv(dto.consulted);
    if (dto.informed != null) set.informed = peopleCsv(dto.informed);
    if (dto.depends_on != null) {
      if (dto.depends_on.some((d) => Number(d) === Number(taskId))) throw new BadRequestException({ code: 'BAD_DEPENDENCY', message: 'A task cannot depend on itself', messageTh: 'งานขึ้นกับตัวเองไม่ได้' });
      set.dependsOn = depsCsv(dto.depends_on);
    }
    // Marking a task done implies 100% complete unless an explicit pct is given.
    if (dto.pct_complete != null) set.pctComplete = fx(clampPct(dto.pct_complete), 2);
    else if (dto.status === 'done') set.pctComplete = fx(100, 2);
    await db.update(projectTasks).set(set).where(eq(projectTasks.id, Number(taskId)));
    const [proj] = await db.select().from(projects).where(eq(projects.id, Number(t.projectId))).limit(1);
    return this.listTasks(proj!.projectCode);
  }

  // Project overall % complete = planned-hours-weighted mean of task pct (simple mean if no planned hours).
  // Cancelled tasks are excluded from the roll-up.
  private taskRollup(rows: any[]) {
    const active = rows.filter((t) => t.status !== 'cancelled');
    if (!active.length) return 0;
    const totalH = active.reduce((s, t) => s + n(t.plannedHours), 0);
    if (totalH > 0) return clampPct(active.reduce((s, t) => s + n(t.plannedHours) * n(t.pctComplete), 0) / totalH);
    return clampPct(active.reduce((s, t) => s + n(t.pctComplete), 0) / active.length);
  }

  // ── RACI accountability (B3) ─────────────────────────────────────────────
  // "My tasks": the caller's still-open tasks across every project where they are the accountable owner or a
  // responsible doer (matched on username). The personal work-queue that the RACI roles drive.
  async myTasks(user: JwtUser) {
    const db = this.db;
    const me = String(user.username ?? '').trim();
    const rows = (await db.select().from(projectTasks).where(sql`${projectTasks.status} not in ('done','cancelled')`)).map(shapeTask);
    const projRows = await db.select().from(projects);
    const pById = new Map<number, any>(projRows.map((p: any) => [Number(p.id), p]));
    const mine = rows
      .filter((t: any) => me && (String(t.accountable ?? '').trim() === me || t.responsible.includes(me)))
      .map((t: any) => {
        const p = pById.get(t.project_id);
        return { ...t, project_code: p?.projectCode ?? null, project_name: p?.name ?? null, my_role: String(t.accountable ?? '').trim() === me ? 'accountable' : 'responsible' };
      })
      .sort((a: any, b: any) => String(a.planned_end ?? '9999-12-31').localeCompare(String(b.planned_end ?? '9999-12-31')));
    return { user: me, tasks: mine, count: mine.length };
  }

  // The project's RACI accountability matrix: per-task A/R/C/I, a per-person role rollup, and the tasks that
  // lack a single accountable owner (an accountability gap). SoD note: the accountable owner should not be the
  // same person who later approves the task's cost/timesheet — surfaced here, enforced by the cost maker-checker.
  async raci(code: string) {
    const db = this.db;
    const p = await this.row(code);
    const rows = (await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id))).orderBy(projectTasks.id)).map(shapeTask);
    const active = rows.filter((t: any) => t.status !== 'cancelled');
    const people = new Map<string, { accountable: number; responsible: number; consulted: number; informed: number }>();
    const bump = (name: string, key: 'accountable' | 'responsible' | 'consulted' | 'informed') => {
      const k = String(name).trim(); if (!k) return;
      const e = people.get(k) ?? { accountable: 0, responsible: 0, consulted: 0, informed: 0 };
      e[key]++; people.set(k, e);
    };
    for (const t of active) {
      if (t.accountable) bump(t.accountable, 'accountable');
      for (const r of t.responsible) bump(r, 'responsible');
      for (const c of t.consulted) bump(c, 'consulted');
      for (const i of t.informed) bump(i, 'informed');
    }
    const missing_accountable = active.filter((t: any) => !t.accountable).map((t: any) => t.id);
    return {
      project_code: code,
      tasks: active.map((t: any) => ({ id: t.id, name: t.name, accountable: t.accountable, responsible: t.responsible, consulted: t.consulted, informed: t.informed })),
      people: [...people.entries()].map(([name, c]) => ({ name, ...c })).sort((a, b) => (b.accountable + b.responsible) - (a.accountable + a.responsible)),
      missing_accountable, complete: missing_accountable.length === 0, count: active.length,
    };
  }

  // ── Milestones (P1) ──────────────────────────────────────────────────────
  async addMilestone(code: string, dto: MilestoneDto, user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    if (dto.billing_percent != null && (dto.billing_percent <= 0 || dto.billing_percent > 100))
      throw new BadRequestException({ code: 'BAD_PERCENT', message: 'billing_percent must be within (0,100]', messageTh: 'เปอร์เซ็นต์ต้องอยู่ระหว่าง 0-100' });
    await db.insert(projectMilestones).values({
      projectId: Number(p.id), tenantId, name: dto.name, dueDate: dto.due_date ?? null, owner: dto.owner ?? null,
      status: 'pending', billingPercent: dto.billing_percent != null ? fx(dto.billing_percent, 2) : null, createdBy: user.username,
    });
    return this.listMilestones(code);
  }

  async listMilestones(code: string) {
    const db = this.db;
    const p = await this.row(code);
    const rows = await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, Number(p.id))).orderBy(projectMilestones.id);
    return { project_code: code, milestones: rows.map(shapeMilestone), count: rows.length };
  }

  // Mark a milestone reached. If it carries a billing_percent, the same act raises the Fixed-price progress
  // bill through the EXISTING authorized PRJ-BILL path (revenue recognition + WIP relief, contract cap) — PROJ-02.
  async reachMilestone(milestoneId: number, user: JwtUser) {
    const db = this.db;
    const [m] = await db.select().from(projectMilestones).where(eq(projectMilestones.id, Number(milestoneId))).limit(1);
    if (!m) throw new NotFoundException({ code: 'MILESTONE_NOT_FOUND', message: `Milestone ${milestoneId} not found`, messageTh: 'ไม่พบหมุดหมาย' });
    if (m.status === 'reached') throw new BadRequestException({ code: 'MILESTONE_REACHED', message: 'Milestone already reached', messageTh: 'หมุดหมายถูกบรรลุแล้ว' });
    const [proj] = await db.select().from(projects).where(eq(projects.id, Number(m.projectId))).limit(1);
    await db.update(projectMilestones).set({ status: 'reached', reachedAt: new Date() }).where(eq(projectMilestones.id, Number(milestoneId)));
    let billing: any = null;
    if (m.billingPercent != null && n(m.billingPercent) > 0) billing = await this.bill(proj!.projectCode, { percent: n(m.billingPercent) }, user);
    return { milestone_id: Number(milestoneId), project_code: proj!.projectCode, status: 'reached', billing };
  }

  // ── Resource rate card (P2) ──────────────────────────────────────────────
  async addRateCard(dto: RateCardDto, user: JwtUser) {
    const db = this.db;
    await db.insert(resourceRates).values({
      tenantId: user.tenantId ?? null, role: dto.role, costRate: fx(dto.cost_rate ?? 0, 2), billRate: fx(dto.bill_rate ?? 0, 2),
      effectiveFrom: dto.effective_from ?? ymd(), effectiveTo: dto.effective_to ?? null, createdBy: user.username,
    });
    return this.listRateCards(user);
  }

  async listRateCards(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(resourceRates).orderBy(desc(resourceRates.id)).limit(300);
    return { rate_cards: rows.map((r: any) => ({ id: Number(r.id), role: r.role, cost_rate: n(r.costRate), bill_rate: n(r.billRate), effective_from: r.effectiveFrom, effective_to: r.effectiveTo })), count: rows.length };
  }

  // Resolve the rate-card rates applicable to a role on a date: the latest effective_from that is on/before the
  // date and whose effective_to is empty or on/after it. Returns zeros if the role has no rate card.
  private async resolveRate(role: string | undefined, onDate: string, user: JwtUser) {
    if (!role) return { costRate: 0, billRate: 0 };
    const db = this.db;
    const conds = [eq(resourceRates.role, role)];
    if (user.tenantId != null) conds.push(eq(resourceRates.tenantId, user.tenantId));
    const rows = await db.select().from(resourceRates).where(and(...conds));
    const applicable = rows
      .filter((r: any) => (!r.effectiveFrom || r.effectiveFrom <= onDate) && (!r.effectiveTo || r.effectiveTo >= onDate))
      .sort((a: any, b: any) => String(b.effectiveFrom ?? '').localeCompare(String(a.effectiveFrom ?? '')));
    const r = applicable[0];
    return { costRate: r ? n(r.costRate) : 0, billRate: r ? n(r.billRate) : 0 };
  }

  // ── Project resource assignment + capacity (P2) ──────────────────────────
  async assignResource(code: string, dto: ResourceDto, user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    const alloc = r2(dto.alloc_pct ?? 100);
    if (alloc <= 0 || alloc > 100) throw new BadRequestException({ code: 'BAD_ALLOC', message: 'alloc_pct must be within (0,100]', messageTh: 'สัดส่วนการจัดสรรต้องอยู่ระหว่าง 0-100' });
    const start = dto.period_start ?? ymd();
    const rate = await this.resolveRate(dto.role, start, user);
    await db.insert(projectResources).values({
      projectId: Number(p.id), tenantId: p.tenantId ?? user.tenantId ?? null, taskId: dto.task_id ?? null,
      resourceName: dto.resource_name, role: dto.role ?? null, allocPct: fx(alloc, 2), periodStart: start, periodEnd: dto.period_end ?? null,
      costRate: fx(rate.costRate, 2), billRate: fx(rate.billRate, 2), createdBy: user.username,
    });
    return this.listResources(code);
  }

  async listResources(code: string) {
    const db = this.db;
    const p = await this.row(code);
    const rows = await db.select().from(projectResources).where(eq(projectResources.projectId, Number(p.id))).orderBy(projectResources.id);
    return { project_code: code, resources: rows.map(shapeResource), count: rows.length };
  }

  // Capacity/utilization (PROJ-05): total allocation per named resource across all of the caller's projects;
  // >100% flags over-allocation (a resource booked beyond capacity).
  async resourceUtilization(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(projectResources);
    const by = new Map<string, number>();
    for (const r of rows) by.set(r.resourceName, r2((by.get(r.resourceName) ?? 0) + n(r.allocPct)));
    const utilization = [...by.entries()]
      .map(([resource_name, total]) => ({ resource_name, allocated_pct: r2(total), over_allocated: total > 100 }))
      .sort((a, b) => b.allocated_pct - a.allocated_pct);
    return { utilization, over_allocated_count: utilization.filter((u) => u.over_allocated).length };
  }

  // Time-phased capacity calendar (PPM upgrade): the flat resourceUtilization rolls every assignment into one
  // number; this buckets each assignment's alloc % into the MONTHS its [period_start, period_end] spans and
  // compares the per-month demand to capacity (100%/resource/month), so a resource over-booked in a *specific*
  // window is visible even when the lifetime average looks fine. Read-only; horizon = `months` from `from`.
  async resourceCapacity(_user: JwtUser, dto?: { months?: number; from?: string }) {
    const db = this.db;
    const months = Math.max(1, Math.min(24, Math.round(dto?.months ?? 6)));
    const start = (dto?.from && /^\d{4}-\d{2}$/.test(dto.from)) ? dto.from : ymd().slice(0, 7);
    const addMonths = (period: string, k: number) => { const [y, m] = period.split('-').map(Number); const idx = y! * 12 + (m! - 1) + k; return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`; };
    const horizon = Array.from({ length: months }, (_, i) => addMonths(start, i));
    const rows = await db.select().from(projectResources);
    // An assignment is active in month M when period_start ≤ M-end and (period_end is open or ≥ M-start). A
    // null period_start means "from project inception" (active from the horizon's first month onward).
    const activeIn = (r: any, month: string) => {
      const mStart = `${month}-01`, mEnd = `${month}-31`;
      const ps = r.periodStart ?? null, pe = r.periodEnd ?? null;
      return (ps == null || ps <= mEnd) && (pe == null || pe >= mStart);
    };
    const byRes = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const name = r.resourceName;
      const m = byRes.get(name) ?? new Map<string, number>();
      for (const month of horizon) if (activeIn(r, month)) m.set(month, r2((m.get(month) ?? 0) + n(r.allocPct)));
      byRes.set(name, m);
    }
    const resources = [...byRes.entries()].map(([resource_name, m]) => {
      const cells = horizon.map((month) => { const pct = r2(m.get(month) ?? 0); return { month, allocated_pct: pct, over_allocated: pct > 100 }; });
      const peak = cells.reduce((mx, c) => Math.max(mx, c.allocated_pct), 0);
      return { resource_name, months: cells, peak_pct: r2(peak), over_months: cells.filter((c) => c.over_allocated).length };
    }).sort((a, b) => b.peak_pct - a.peak_pct);
    const monthly = horizon.map((month) => {
      const cells = resources.map((r) => r.months.find((c) => c.month === month)!);
      return { month, total_demand_pct: r2(cells.reduce((s, c) => s + c.allocated_pct, 0)), resources_over: cells.filter((c) => c.over_allocated).length };
    });
    return { from: start, months, horizon, resources, monthly, over_allocated_count: resources.filter((r) => r.over_months > 0).length };
  }

  // ── Earned-value management (P4, PROJ-06) ────────────────────────────────
  // Computes BAC / PV / EV / AC → CPI / SPI + cost & schedule variance + EAC/ETC from the project's WBS tasks
  // (planned cost, % complete, planned_end schedule) and its actual cost incurred, and reconciles EV/AC against
  // the project's WIP actuals. `as_of` defaults to the business day; PV counts tasks scheduled to finish by then.
  async evm(code: string, asOf?: string) {
    const db = this.db;
    const p = await this.row(code);
    const tasks = (await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id)))).filter((t: any) => t.status !== 'cancelled');
    const today = asOf ?? ymd();
    let bac = 0, ev = 0, pv = 0;
    for (const t of tasks) {
      const pc = n(t.plannedCost);
      bac = r2(bac + pc);
      ev = r2(ev + pc * clampPct(t.pctComplete) / 100);
      // Planned value = budgeted cost of work scheduled by `as_of` (a task with no planned_end counts as scheduled).
      if (!t.plannedEnd || t.plannedEnd <= today) pv = r2(pv + pc);
    }
    // Fall back to the project budget as the baseline when no task planned cost is set.
    if (bac === 0) { bac = n(p.budgetAmount); pv = bac; }
    // Actual cost incurred = recoverable WIP cost (cost_to_date) + non-billable (the project's total actual cost).
    const nbRows = await db.select({ v: sql<string>`coalesce(sum(${projectEntries.amount}),0)` }).from(projectEntries)
      .where(and(eq(projectEntries.projectId, Number(p.id)), eq(projectEntries.billable, false)));
    const ac = r2(n(p.costToDate) + n(nbRows[0]?.v));
    const cpi = ac > 0 ? r4(ev / ac) : null;        // >1 under cost, <1 over cost
    const spi = pv > 0 ? r4(ev / pv) : null;        // >1 ahead of schedule, <1 behind
    const eac = cpi && cpi > 0 ? r2(ac + (bac - ev) / cpi) : r2(ac + (bac - ev)); // estimate at completion
    return {
      project_code: code, as_of: today, bac, pv, ev, ac,
      cost_variance: r2(ev - ac), schedule_variance: r2(ev - pv),
      cpi, spi, eac, etc: r2(eac - ac), task_count: tasks.length,
    };
  }

  // Critical-path schedule (CPM) over the WBS: a forward pass (early start/finish) + backward pass (late
  // start/finish) on the finish-to-start `depends_on` graph, with each task's duration in days (explicit
  // planned_start→planned_end span, else planned_hours/8, min 1). Tasks with zero slack are on the critical
  // path. Cancelled tasks are excluded; a dependency cycle degrades gracefully (the back-edge is ignored).
  async schedule(code: string) {
    const db = this.db;
    const p = await this.row(code);
    const rows = (await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id)))).filter((t: any) => t.status !== 'cancelled');
    const tasks = rows.map(shapeTask);
    const byId = new Map<number, any>(tasks.map((t: any) => [t.id, t]));
    const dur = (t: any) => {
      if (t.planned_start && t.planned_end) return Math.max(1, Math.round((Date.parse(t.planned_end) - Date.parse(t.planned_start)) / 86400000) + 1);
      return Math.max(1, Math.ceil(n(t.planned_hours) / 8) || 1);
    };
    // Predecessors restricted to known tasks; build successor adjacency.
    const preds = new Map<number, number[]>(tasks.map((t: any) => [t.id, (t.depends_on || []).filter((d: number) => byId.has(d) && d !== t.id)]));
    const succ = new Map<number, number[]>(tasks.map((t: any) => [t.id, []]));
    for (const t of tasks) for (const d of preds.get(t.id)!) succ.get(d)!.push(t.id);
    // Topological order (Kahn); any nodes left in a cycle are appended so the passes still terminate.
    const indeg = new Map<number, number>(tasks.map((t: any) => [t.id, preds.get(t.id)!.length]));
    const queue = tasks.filter((t: any) => indeg.get(t.id) === 0).map((t: any) => t.id);
    const topo: number[] = [];
    while (queue.length) {
      const id = queue.shift()!; topo.push(id);
      for (const s of succ.get(id)!) { indeg.set(s, indeg.get(s)! - 1); if (indeg.get(s) === 0) queue.push(s); }
    }
    for (const t of tasks) if (!topo.includes(t.id)) topo.push(t.id);
    const es = new Map<number, number>(), ef = new Map<number, number>();
    for (const id of topo) {
      const start = Math.max(0, ...preds.get(id)!.map((d) => ef.get(d) ?? 0));
      es.set(id, start); ef.set(id, start + dur(byId.get(id)));
    }
    const projectDuration = Math.max(0, ...tasks.map((t: any) => ef.get(t.id) ?? 0));
    const lf = new Map<number, number>(), ls = new Map<number, number>();
    for (const id of [...topo].reverse()) {
      const succs = succ.get(id)!;
      const finish = succs.length ? Math.min(...succs.map((s) => ls.get(s)!)) : projectDuration;
      lf.set(id, finish); ls.set(id, finish - dur(byId.get(id)));
    }
    const out = tasks.map((t: any) => {
      const slack = r2((ls.get(t.id) ?? 0) - (es.get(t.id) ?? 0));
      return { ...t, duration_days: dur(t), es: es.get(t.id) ?? 0, ef: ef.get(t.id) ?? 0, ls: ls.get(t.id) ?? 0, lf: lf.get(t.id) ?? 0, slack, on_critical_path: slack <= 0.0001 };
    });
    return {
      project_code: code, project_duration_days: projectDuration,
      critical_path: out.filter((t: any) => t.on_critical_path).map((t: any) => t.id),
      tasks: out, count: out.length,
    };
  }

  // ── Program (cross-project) critical path (PMO-4) ────────────────────────
  // Group a project into a program + declare which OTHER projects it must follow (finish-to-start). The
  // member projects + those dependencies form a higher-level graph whose nodes are whole projects (node
  // duration = each project's OWN critical-path duration from schedule()); a forward/backward CPM pass over
  // it gives the PROGRAM critical path, end date, and per-project slack — so a delay that ripples ACROSS
  // projects is visible, not just within one. Detective/non-posting (rides PROJ-06).
  async setProgram(code: string, dto: ProgramDto, user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    const set: any = {};
    if (dto.program_code !== undefined) set.programCode = (dto.program_code ?? '').toString().trim() || null;
    if (dto.depends_on_projects !== undefined) {
      const deps = peopleCsv(dto.depends_on_projects); // trim + dedupe project codes (null when empty)
      if (deps) {
        const list = csvToList(deps);
        if (list.includes(code)) throw new BadRequestException({ code: 'BAD_DEPENDENCY', message: 'A project cannot depend on itself', messageTh: 'โครงการขึ้นกับตัวเองไม่ได้' });
        for (const c of list) {
          const [exists] = await db.select().from(projects).where(eq(projects.projectCode, c)).limit(1);
          if (!exists) throw new BadRequestException({ code: 'DEP_PROJECT_NOT_FOUND', message: `Dependency project ${c} not found`, messageTh: `ไม่พบโครงการที่อ้างอิง (${c})` });
        }
      }
      set.dependsOnProjects = deps;
    }
    await db.update(projects).set(set).where(eq(projects.id, Number(p.id)));
    return this.get(code);
  }

  async programCriticalPath(programCode: string, _user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(projects).where(eq(projects.programCode, programCode));
    if (!rows.length) throw new NotFoundException({ code: 'PROGRAM_NOT_FOUND', message: `No projects in program ${programCode}`, messageTh: 'ไม่พบโปรแกรม' });
    const members = new Set<string>(rows.map((p: any) => p.projectCode));
    // node duration = each project's own critical-path duration (≥1 so a plan-less project still occupies a day).
    const nodes: { code: string; name: string; status: string; duration: number; preds: string[] }[] = [];
    for (const p of rows) {
      const sched = await this.schedule(p.projectCode);
      const preds = csvToList(p.dependsOnProjects).filter((c) => members.has(c) && c !== p.projectCode);
      nodes.push({ code: p.projectCode, name: p.name, status: p.status, duration: Math.max(1, sched.project_duration_days || 0), preds });
    }
    const byCode = new Map(nodes.map((n) => [n.code, n]));
    const succ = new Map<string, string[]>(nodes.map((n) => [n.code, []]));
    for (const n of nodes) for (const d of n.preds) succ.get(d)!.push(n.code);
    // Topological order (Kahn); cycle-trapped nodes are appended so the passes still terminate.
    const indeg = new Map<string, number>(nodes.map((n) => [n.code, n.preds.length]));
    const queue = nodes.filter((n) => indeg.get(n.code) === 0).map((n) => n.code);
    const topo: string[] = [];
    while (queue.length) { const c = queue.shift()!; topo.push(c); for (const s of succ.get(c)!) { indeg.set(s, indeg.get(s)! - 1); if (indeg.get(s) === 0) queue.push(s); } }
    for (const n of nodes) if (!topo.includes(n.code)) topo.push(n.code);
    const es = new Map<string, number>(), ef = new Map<string, number>();
    for (const c of topo) { const start = Math.max(0, ...byCode.get(c)!.preds.map((d) => ef.get(d) ?? 0)); es.set(c, start); ef.set(c, start + byCode.get(c)!.duration); }
    const programDuration = Math.max(0, ...nodes.map((n) => ef.get(n.code) ?? 0));
    const lf = new Map<string, number>(), ls = new Map<string, number>();
    for (const c of [...topo].reverse()) { const ss = succ.get(c)!; const finish = ss.length ? Math.min(...ss.map((s) => ls.get(s)!)) : programDuration; lf.set(c, finish); ls.set(c, finish - byCode.get(c)!.duration); }
    const out = nodes.map((n) => {
      const slack = r2((ls.get(n.code) ?? 0) - (es.get(n.code) ?? 0));
      return { project_code: n.code, name: n.name, status: n.status, duration_days: n.duration, depends_on: n.preds, es: es.get(n.code) ?? 0, ef: ef.get(n.code) ?? 0, ls: ls.get(n.code) ?? 0, lf: lf.get(n.code) ?? 0, slack, on_critical_path: slack <= 0.0001 };
    }).sort((a, b) => a.es - b.es || a.project_code.localeCompare(b.project_code));
    return { program_code: programCode, project_count: out.length, program_duration_days: programDuration, critical_path: out.filter((p) => p.on_critical_path).map((p) => p.project_code), projects: out };
  }

  async programs(user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(projects).where(sql`${projects.programCode} is not null`);
    const byProg = new Map<string, number>();
    for (const p of rows) { const k = p.programCode as string; if (!k) continue; byProg.set(k, (byProg.get(k) ?? 0) + 1); }
    const out: any[] = [];
    for (const program_code of [...byProg.keys()].sort()) {
      const cp = await this.programCriticalPath(program_code, user);
      out.push({ program_code, member_count: byProg.get(program_code), program_duration_days: cp.program_duration_days, critical_path: cp.critical_path });
    }
    return { programs: out, count: out.length };
  }

  // EVM S-curve: the planned-cost baseline accumulated by month (each task's planned cost lands in its
  // planned_end month), with the current EV/AC/PV snapshot overlaid — the classic planned-vs-actual S-curve.
  async evmSeries(code: string, dto?: { months?: number }) {
    const db = this.db;
    const p = await this.row(code);
    const tasks = (await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id)))).filter((t: any) => t.status !== 'cancelled');
    const buckets = new Map<string, number>();
    for (const t of tasks) {
      const m = t.plannedEnd ? String(t.plannedEnd).slice(0, 7) : (p.startDate ? String(p.startDate).slice(0, 7) : ymd().slice(0, 7));
      buckets.set(m, r2((buckets.get(m) ?? 0) + n(t.plannedCost)));
    }
    let cumulative = 0;
    const series = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, planned]) => {
      cumulative = r2(cumulative + planned);
      return { month, planned_cost: planned, cumulative_planned: cumulative };
    });
    const current = await this.evm(code, dto && (dto as any).as_of);
    return { project_code: code, series, current, bac: current.bac };
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
      if ((e.cpi != null && e.cpi < 0.9) || (e.spi != null && e.spi < 0.9)) push('project_red', 'high', pid, code, `สุขภาพโครงการแดง (CPI ${e.cpi ?? '—'} / SPI ${e.spi ?? '—'})`, `Project health red (CPI ${e.cpi ?? '—'} / SPI ${e.spi ?? '—'})`, `CPI ${e.cpi ?? '—'}`, 'overview', { cpi: e.cpi, spi: e.spi });
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
      const rag = this.ragOf(e.cpi, e.spi);
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

  private ragOf(cpi: number | null, spi: number | null): string {
    if (cpi == null && spi == null) return 'no_data';
    if ((cpi != null && cpi < 0.9) || (spi != null && spi < 0.9)) return 'red';
    if ((cpi != null && cpi < 1) || (spi != null && spi < 1)) return 'amber';
    return 'green';
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
      rag: this.ragOf(e.cpi, e.spi), pct_complete: detail.pct_complete,
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

  // ── Baselines & variance (B1, PROJ-07) ───────────────────────────────────
  // Current planned BAC (Σ non-cancelled task planned cost; falls back to the project budget) + critical-path
  // duration — the figures a baseline snapshots and the current plan is compared against.
  private async currentPlan(code: string, p: any) {
    const db = this.db;
    const tasks = (await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id)))).filter((t: any) => t.status !== 'cancelled');
    let bac = r2(tasks.reduce((s: number, t: any) => s + n(t.plannedCost), 0));
    if (bac === 0) bac = n(p.budgetAmount);
    const sched = await this.schedule(code);
    return { bac, duration_days: sched.project_duration_days };
  }

  // Capture a baseline. The FIRST baseline is free; **re-baselining requires a reason** (BASELINE_REASON_REQUIRED)
  // and supersedes the prior active baseline (history preserved) — a project can't silently move its goalposts.
  async captureBaseline(code: string, dto: BaselineDto, user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    const tenantId = p.tenantId ?? user.tenantId ?? null;
    const plan = await this.currentPlan(code, p);
    const [active] = await db.select().from(projectBaselines).where(and(eq(projectBaselines.projectId, Number(p.id)), eq(projectBaselines.status, 'active'))).limit(1);
    if (active && !dto.reason) throw new BadRequestException({ code: 'BASELINE_REASON_REQUIRED', message: 'Re-baselining requires a reason', messageTh: 'การตั้งเส้นฐานใหม่ต้องระบุเหตุผล' });
    if (active) await db.update(projectBaselines).set({ status: 'superseded' }).where(eq(projectBaselines.id, Number(active.id)));
    await db.insert(projectBaselines).values({
      projectId: Number(p.id), tenantId, label: dto.label ?? (active ? 'Re-baseline' : 'Baseline'),
      baselineBac: fx(plan.bac, 2), baselineDurationDays: plan.duration_days, baselineEnd: p.endDate ?? null,
      reason: dto.reason ?? null, status: 'active', createdBy: user.username,
    });
    return this.getBaseline(code, user);
  }

  // The active baseline + the current plan + variance (scope/cost creep) + the full baseline history.
  async getBaseline(code: string, _user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    const all = await db.select().from(projectBaselines).where(eq(projectBaselines.projectId, Number(p.id))).orderBy(desc(projectBaselines.id));
    const active = all.find((b: any) => b.status === 'active') ?? null;
    const plan = await this.currentPlan(code, p);
    const variance = active ? {
      bac_delta: r2(plan.bac - n(active.baselineBac)),
      bac_pct: n(active.baselineBac) > 0 ? r2(((plan.bac - n(active.baselineBac)) / n(active.baselineBac)) * 100) : null,
      duration_delta: plan.duration_days - Number(active.baselineDurationDays),
    } : null;
    return { project_code: code, baseline: active ? shapeBaseline(active) : null, current: plan, variance, history: all.map(shapeBaseline) };
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
  async approveBoq(boqId: number, user: JwtUser) {
    const db = this.db;
    const boq = await this.boqRow(boqId);
    if (boq.status !== 'draft') throw new BadRequestException({ code: 'BOQ_NOT_DRAFT', message: `BoQ is already ${boq.status}`, messageTh: 'BoQ ถูกดำเนินการแล้ว' });
    if (boq.createdBy && boq.createdBy === user.username) throw new BadRequestException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve a BoQ you authored', messageTh: 'ผู้จัดทำ BoQ อนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)' });
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
  async approveChangeOrder(coId: number, user: JwtUser) {
    const db = this.db;
    const [co] = await db.select().from(projectChangeOrders).where(eq(projectChangeOrders.id, Number(coId))).limit(1);
    if (!co) throw new NotFoundException({ code: 'CHANGE_ORDER_NOT_FOUND', message: `Change order ${coId} not found`, messageTh: 'ไม่พบใบเปลี่ยนแปลง' });
    if (co.status !== 'pending') throw new BadRequestException({ code: 'CHANGE_ORDER_DECIDED', message: `Change order is already ${co.status}`, messageTh: 'ใบเปลี่ยนแปลงถูกตัดสินแล้ว' });
    if (co.requestedBy && co.requestedBy === user.username) throw new BadRequestException({ code: 'SOD_SELF_APPROVAL', message: 'Maker-checker: you cannot approve a change order you requested', messageTh: 'ผู้ขอเปลี่ยนแปลงอนุมัติเองไม่ได้ (แบ่งแยกหน้าที่)' });
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

  // ── Project health history (PPM upgrade) ─────────────────────────────────
  // Capture a dated EVM/RAG snapshot for ONE project, so the live point-in-time EVM gains a trajectory. RAG:
  // red if CPI or SPI < 0.9, amber if either < 1, green if both ≥ 1, no_data if neither is computable.
  // Idempotent per (project, date) — re-capturing the same day refreshes the row.
  async captureHealth(code: string, dto: { as_of?: string }, user: JwtUser) {
    const db = this.db;
    const p = await this.row(code);
    return this.snapProject(p, dto?.as_of ?? ymd(), user);
  }

  // Capture a snapshot for EVERY project for the caller's tenant — the scheduled (BI action job) path.
  async captureAllHealth(user: JwtUser) {
    const db = this.db;
    const date = ymd();
    const rows = await db.select().from(projects).orderBy(desc(projects.id)).limit(500);
    let captured = 0;
    for (const p of rows) { await this.snapProject(p, date, user); captured++; }
    return { as_of: date, scanned: rows.length, captured };
  }

  // Compute + upsert one project's health snapshot for a date.
  private async snapProject(p: any, date: string, user: JwtUser) {
    const db = this.db;
    const e = await this.evm(p.projectCode, date);
    const f = this.fmt(p);
    const tasks = await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id)));
    const pct = this.taskRollup(tasks);
    const rag = (e.cpi == null && e.spi == null) ? 'no_data'
      : ((e.cpi != null && e.cpi < 0.9) || (e.spi != null && e.spi < 0.9)) ? 'red'
      : ((e.cpi != null && e.cpi < 1) || (e.spi != null && e.spi < 1)) ? 'amber' : 'green';
    const row = {
      tenantId: p.tenantId ?? user.tenantId ?? null, snapshotDate: date, rag,
      cpi: e.cpi != null ? fx(e.cpi, 4) : null, spi: e.spi != null ? fx(e.spi, 4) : null,
      pctComplete: fx(pct, 2), bac: fx(e.bac, 2), ev: fx(e.ev, 2), ac: fx(e.ac, 2), eac: fx(e.eac, 2),
      margin: fx(f.margin, 2), wip: fx(f.wip, 2), createdBy: user.username,
    };
    await db.insert(projectHealthSnapshots).values({ projectId: Number(p.id), ...row })
      .onConflictDoUpdate({ target: [projectHealthSnapshots.projectId, projectHealthSnapshots.snapshotDate], set: { ...row, createdAt: new Date() } });
    // PMO-1: a red snapshot proactively wakes the action center rather than waiting for someone to look.
    if (rag === 'red') this.emitAction(p.tenantId ?? user.tenantId ?? null, 'project_red', 'high', p.projectCode, { cpi: e.cpi, spi: e.spi, snapshot_date: date });
    return { project_code: p.projectCode, snapshot_date: date, rag, cpi: e.cpi, spi: e.spi, margin: f.margin };
  }

  // The dated health trajectory for a project (ascending) — feeds a CPI/SPI/RAG trend chart.
  async healthHistory(code: string) {
    const db = this.db;
    const p = await this.row(code);
    const rows = await db.select().from(projectHealthSnapshots).where(eq(projectHealthSnapshots.projectId, Number(p.id))).orderBy(projectHealthSnapshots.snapshotDate);
    return { project_code: code, history: rows.map(shapeHealth), count: rows.length };
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
      budget_amount: budget, contract_amount: n(p.contractAmount),
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
    const [existing] = await db.select().from(projectCloseReviews).where(and(eq(projectCloseReviews.tenantId, user.tenantId ?? null as any), eq(projectCloseReviews.period, period))).limit(1);
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
  async approveCloseReview(period: string, user: JwtUser) {
    const db = this.db;
    const [rp] = await db.select().from(projectCloseReviews).where(and(eq(projectCloseReviews.tenantId, user.tenantId ?? null as any), eq(projectCloseReviews.period, period))).limit(1);
    if (!rp) throw new NotFoundException({ code: 'NOT_PREPARED', message: `Project close review for ${period} has not been prepared`, messageTh: 'ยังไม่ได้จัดทำการสอบทาน' });
    if (rp.status !== 'Prepared') throw new BadRequestException({ code: 'NOT_PREPARED', message: `Project close review is ${rp.status}, not Prepared`, messageTh: 'สถานะไม่ใช่ Prepared' });
    if (rp.preparedBy && rp.preparedBy === user.username) throw new ForbiddenException({ code: 'SOD_VIOLATION', message: 'Maker-checker: the approver must differ from the preparer', messageTh: 'ผู้อนุมัติต้องไม่ใช่ผู้จัดทำ (แบ่งแยกหน้าที่)' });
    await db.update(projectCloseReviews).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date() }).where(eq(projectCloseReviews.id, rp.id));
    return this.getCloseReview(period, user);
  }

  async rejectCloseReview(period: string, reason: string, user: JwtUser) {
    const db = this.db;
    const [rp] = await db.select().from(projectCloseReviews).where(and(eq(projectCloseReviews.tenantId, user.tenantId ?? null as any), eq(projectCloseReviews.period, period))).limit(1);
    if (!rp) throw new NotFoundException({ code: 'NOT_PREPARED', message: 'Project close review has not been prepared', messageTh: 'ยังไม่ได้จัดทำ' });
    if (rp.status !== 'Prepared') throw new BadRequestException({ code: 'NOT_PREPARED', message: `Project close review is ${rp.status}, not Prepared`, messageTh: 'สถานะไม่ใช่ Prepared' });
    await db.update(projectCloseReviews).set({ status: 'Rejected', rejectionReason: reason ?? null }).where(eq(projectCloseReviews.id, rp.id));
    return this.getCloseReview(period, user);
  }

  async getCloseReview(period: string, user: JwtUser) {
    const db = this.db;
    const [rp] = await db.select().from(projectCloseReviews).where(and(eq(projectCloseReviews.tenantId, user.tenantId ?? null as any), eq(projectCloseReviews.period, period))).limit(1);
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

function shapeTask(t: any) {
  return { id: Number(t.id), project_id: Number(t.projectId), parent_id: t.parentId != null ? Number(t.parentId) : null, wbs_code: t.wbsCode, name: t.name, status: t.status, planned_start: t.plannedStart, planned_end: t.plannedEnd, planned_hours: n(t.plannedHours), planned_cost: n(t.plannedCost), pct_complete: n(t.pctComplete), depends_on: t.dependsOn ? String(t.dependsOn).split(',').map((x: string) => Number(x)).filter((x: number) => Number.isFinite(x)) : [], assignee: t.assignee, accountable: t.accountable ?? null, responsible: csvToList(t.responsible), consulted: csvToList(t.consulted), informed: csvToList(t.informed), created_at: t.createdAt };
}
function shapeMilestone(m: any) {
  return { id: Number(m.id), project_id: Number(m.projectId), name: m.name, due_date: m.dueDate, owner: m.owner, status: m.status, billing_percent: m.billingPercent != null ? n(m.billingPercent) : null, reached_at: m.reachedAt, created_at: m.createdAt };
}
function shapeResource(r: any) {
  return { id: Number(r.id), project_id: Number(r.projectId), task_id: r.taskId != null ? Number(r.taskId) : null, resource_name: r.resourceName, role: r.role, alloc_pct: n(r.allocPct), period_start: r.periodStart, period_end: r.periodEnd, cost_rate: n(r.costRate), bill_rate: n(r.billRate), created_at: r.createdAt };
}
function shapeTemplateItem(it: any) {
  return { id: Number(it.id), item_type: it.itemType, seq: Number(it.seq), name: it.name, parent_seq: it.parentSeq != null ? Number(it.parentSeq) : null, wbs_code: it.wbsCode, planned_hours: n(it.plannedHours), planned_cost: n(it.plannedCost), offset_start_days: Number(it.offsetStartDays ?? 0), offset_end_days: Number(it.offsetEndDays ?? 0), depends_on_seq: it.dependsOnSeq ? String(it.dependsOnSeq).split(',').map((x: string) => Number(x)).filter((x: number) => Number.isFinite(x)) : [], billing_percent: it.billingPercent != null ? n(it.billingPercent) : null, owner: it.owner, assignee: it.assignee };
}
function shapeRisk(r: any) {
  return { id: Number(r.id), project_id: Number(r.projectId), kind: r.kind, title: r.title, status: r.status, probability: r.probability != null ? Number(r.probability) : null, impact: Number(r.impact), score: Number(r.score), rag: r.rag, owner: r.owner, mitigation: r.mitigation, due_date: r.dueDate, created_by: r.createdBy, created_at: r.createdAt, closed_at: r.closedAt };
}
function shapeHealth(h: any) {
  return { snapshot_date: h.snapshotDate, rag: h.rag, cpi: h.cpi != null ? n(h.cpi) : null, spi: h.spi != null ? n(h.spi) : null, pct_complete: n(h.pctComplete), bac: n(h.bac), ev: n(h.ev), ac: n(h.ac), eac: n(h.eac), margin: n(h.margin), wip: n(h.wip), created_at: h.createdAt };
}
function shapeChangeOrder(c: any) {
  return { id: Number(c.id), co_no: c.coNo, description: c.description, contract_delta: n(c.contractDelta), budget_delta: n(c.budgetDelta), estimated_cost_delta: n(c.estimatedCostDelta), reason: c.reason, status: c.status, requested_by: c.requestedBy, approved_by: c.approvedBy, created_at: c.createdAt, approved_at: c.approvedAt };
}
function shapeBaseline(b: any) {
  return { id: Number(b.id), label: b.label, baseline_bac: n(b.baselineBac), baseline_duration_days: Number(b.baselineDurationDays), baseline_end: b.baselineEnd, reason: b.reason, status: b.status, created_by: b.createdBy, captured_at: b.capturedAt };
}
// BoQ line (M0, docs/32). remeasure_variance_qty = remeasured − budgeted (null until re-measured).
function shapeBoqLine(l: any) {
  const remeasured = l.remeasuredQty != null ? n(l.remeasuredQty) : null;
  return {
    id: Number(l.id), line_no: Number(l.lineNo), category: l.category, item_no: l.itemNo ?? null, task_id: l.taskId != null ? Number(l.taskId) : null,
    wbs_code: l.wbsCode ?? null, description: l.description ?? null, uom: l.uom ?? null,
    budget_qty: n(l.budgetQty), rate: n(l.rate), budget_amount: n(l.budgetAmount),
    remeasured_qty: remeasured, remeasure_variance_qty: remeasured != null ? r2(remeasured - n(l.budgetQty)) : null,
  };
}

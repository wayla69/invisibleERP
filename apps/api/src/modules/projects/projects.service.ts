import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projects, projectEntries, projectTasks, projectMilestones, projectResources, resourceRates, projectBaselines, projectTemplates, projectTemplateItems, projectRisks, crmOpportunities, customerMaster } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
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
export interface CostDto { entry_type?: 'time' | 'expense'; description?: string; qty?: number; rate?: number; amount?: number; billable?: boolean; entry_date?: string }
export interface BillDto { amount?: number; percent?: number }
export interface FromOpportunityDto { project_code?: string; billing_type?: 'TM' | 'Fixed'; budget_amount?: number; start_date?: string; end_date?: string }
export interface TaskDto { name: string; parent_id?: number; wbs_code?: string; status?: string; planned_start?: string; planned_end?: string; planned_hours?: number; planned_cost?: number; pct_complete?: number; assignee?: string; depends_on?: number[]; accountable?: string; responsible?: string[]; consulted?: string[]; informed?: string[] }
export interface TaskPatchDto { name?: string; status?: string; planned_start?: string; planned_end?: string; planned_hours?: number; planned_cost?: number; pct_complete?: number; assignee?: string; depends_on?: number[]; accountable?: string; responsible?: string[]; consulted?: string[]; informed?: string[] }
export interface MilestoneDto { name: string; due_date?: string; owner?: string; billing_percent?: number }
export interface RateCardDto { role: string; cost_rate?: number; bill_rate?: number; effective_from?: string; effective_to?: string }
export interface ResourceDto { resource_name: string; role?: string; task_id?: number; alloc_pct?: number; period_start?: string; period_end?: string }
export interface BaselineDto { label?: string; reason?: string }
export interface TemplateItemDto { item_type?: 'task' | 'milestone'; seq?: number; name: string; parent_seq?: number; wbs_code?: string; planned_hours?: number; planned_cost?: number; offset_start_days?: number; offset_end_days?: number; depends_on_seq?: number[]; billing_percent?: number; owner?: string; assignee?: string }
export interface TemplateDto { code?: string; name: string; description?: string; items?: TemplateItemDto[] }
export interface ApplyTemplateDto { start_date?: string }
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
  ) {}

  async create(dto: CreateProjectDto, user: JwtUser) {
    const db = this.db as any;
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
    const db = this.db as any;
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
    const db = this.db as any;
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
      source: 'PRJ-COST', sourceRef: `${code}:${Number(e.id)}`, tenantId, memo: `Project cost ${code}${billable ? '' : ' (non-billable)'}`, createdBy: user.username,
      lines: billable
        ? [{ account_code: '1260', debit: amount, memo: `WIP ${code}` }, { account_code: '2390', credit: amount, memo: conv }]
        : [{ account_code: '5800', debit: amount, memo: `Non-billable cost ${code}` }, { account_code: '2390', credit: amount, memo: conv }],
    });
    await db.update(projectEntries).set({ entryNo: je.entry_no }).where(eq(projectEntries.id, Number(e.id)));
    // Only billable costs accumulate in the recoverable WIP (cost_to_date); non-billable are already expensed.
    const costToDate = billable ? r2(n(p.costToDate) + amount) : n(p.costToDate);
    await db.update(projects).set({ costToDate: fx(costToDate, 2), status: p.status === 'Open' ? 'Active' : p.status }).where(eq(projects.id, Number(p.id)));
    return { project_code: code, entry_no: je.entry_no, amount, billable, cost_to_date: costToDate };
  }

  // Bill the customer → recognize revenue + relieve outstanding WIP to cost of services.
  // GL: Dr 1100 AR / Cr 4200 Revenue ; Dr 5800 COGS / Cr 1260 WIP (for the unrecognized cost).
  async bill(code: string, dto: BillDto, user: JwtUser) {
    const db = this.db as any;
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
    const db = this.db as any;
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
    const db = this.db as any;
    const rows = await db.select().from(projects).orderBy(desc(projects.id)).limit(100);
    // Aggregate the non-billable (already-expensed) cost per project so the register shows total cost + true margin.
    const nb = await db.select({ pid: projectEntries.projectId, v: sql<string>`coalesce(sum(${projectEntries.amount}),0)` })
      .from(projectEntries).where(eq(projectEntries.billable, false)).groupBy(projectEntries.projectId);
    const nbBy = new Map<number, number>(nb.map((x: any) => [Number(x.pid), n(x.v)]));
    return { projects: rows.map((r: any) => this.fmt(r, nbBy.get(Number(r.id)) ?? 0)), count: rows.length };
  }

  async get(code: string) {
    const db = this.db as any;
    const p = await this.row(code);
    const entries = await db.select().from(projectEntries).where(eq(projectEntries.projectId, Number(p.id))).orderBy(desc(projectEntries.id));
    const nonBillable = r2(entries.filter((e: any) => e.billable === false).reduce((s: number, e: any) => s + n(e.amount), 0));
    // P1: schedule progress — overall % complete rolls up from the project's WBS tasks (planned-hours-weighted).
    const tasks = await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id)));
    return {
      ...this.fmt(p, nonBillable),
      pct_complete: this.taskRollup(tasks),
      task_count: tasks.length,
      entries: entries.map((e: any) => ({ entry_type: e.entryType, description: e.description, qty: n(e.qty), rate: n(e.rate), amount: n(e.amount), billable: e.billable !== false, entry_date: e.entryDate, entry_no: e.entryNo })),
    };
  }

  // ── WBS tasks (P1) ───────────────────────────────────────────────────────
  async addTask(code: string, dto: TaskDto, user: JwtUser) {
    const db = this.db as any;
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
    const db = this.db as any;
    const p = await this.row(code);
    const rows = await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id))).orderBy(projectTasks.id);
    return { project_code: code, pct_complete: this.taskRollup(rows), tasks: rows.map(shapeTask), count: rows.length };
  }

  async patchTask(taskId: number, dto: TaskPatchDto, user: JwtUser) {
    const db = this.db as any;
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
    return this.listTasks(proj.projectCode);
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
    const db = this.db as any;
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
    const db = this.db as any;
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
    const db = this.db as any;
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
    const db = this.db as any;
    const p = await this.row(code);
    const rows = await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, Number(p.id))).orderBy(projectMilestones.id);
    return { project_code: code, milestones: rows.map(shapeMilestone), count: rows.length };
  }

  // Mark a milestone reached. If it carries a billing_percent, the same act raises the Fixed-price progress
  // bill through the EXISTING authorized PRJ-BILL path (revenue recognition + WIP relief, contract cap) — PROJ-02.
  async reachMilestone(milestoneId: number, user: JwtUser) {
    const db = this.db as any;
    const [m] = await db.select().from(projectMilestones).where(eq(projectMilestones.id, Number(milestoneId))).limit(1);
    if (!m) throw new NotFoundException({ code: 'MILESTONE_NOT_FOUND', message: `Milestone ${milestoneId} not found`, messageTh: 'ไม่พบหมุดหมาย' });
    if (m.status === 'reached') throw new BadRequestException({ code: 'MILESTONE_REACHED', message: 'Milestone already reached', messageTh: 'หมุดหมายถูกบรรลุแล้ว' });
    const [proj] = await db.select().from(projects).where(eq(projects.id, Number(m.projectId))).limit(1);
    await db.update(projectMilestones).set({ status: 'reached', reachedAt: new Date() }).where(eq(projectMilestones.id, Number(milestoneId)));
    let billing: any = null;
    if (m.billingPercent != null && n(m.billingPercent) > 0) billing = await this.bill(proj.projectCode, { percent: n(m.billingPercent) }, user);
    return { milestone_id: Number(milestoneId), project_code: proj.projectCode, status: 'reached', billing };
  }

  // ── Resource rate card (P2) ──────────────────────────────────────────────
  async addRateCard(dto: RateCardDto, user: JwtUser) {
    const db = this.db as any;
    await db.insert(resourceRates).values({
      tenantId: user.tenantId ?? null, role: dto.role, costRate: fx(dto.cost_rate ?? 0, 2), billRate: fx(dto.bill_rate ?? 0, 2),
      effectiveFrom: dto.effective_from ?? ymd(), effectiveTo: dto.effective_to ?? null, createdBy: user.username,
    });
    return this.listRateCards(user);
  }

  async listRateCards(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(resourceRates).orderBy(desc(resourceRates.id)).limit(300);
    return { rate_cards: rows.map((r: any) => ({ id: Number(r.id), role: r.role, cost_rate: n(r.costRate), bill_rate: n(r.billRate), effective_from: r.effectiveFrom, effective_to: r.effectiveTo })), count: rows.length };
  }

  // Resolve the rate-card rates applicable to a role on a date: the latest effective_from that is on/before the
  // date and whose effective_to is empty or on/after it. Returns zeros if the role has no rate card.
  private async resolveRate(role: string | undefined, onDate: string, user: JwtUser) {
    if (!role) return { costRate: 0, billRate: 0 };
    const db = this.db as any;
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
    const db = this.db as any;
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
    const db = this.db as any;
    const p = await this.row(code);
    const rows = await db.select().from(projectResources).where(eq(projectResources.projectId, Number(p.id))).orderBy(projectResources.id);
    return { project_code: code, resources: rows.map(shapeResource), count: rows.length };
  }

  // Capacity/utilization (PROJ-05): total allocation per named resource across all of the caller's projects;
  // >100% flags over-allocation (a resource booked beyond capacity).
  async resourceUtilization(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(projectResources);
    const by = new Map<string, number>();
    for (const r of rows) by.set(r.resourceName, r2((by.get(r.resourceName) ?? 0) + n(r.allocPct)));
    const utilization = [...by.entries()]
      .map(([resource_name, total]) => ({ resource_name, allocated_pct: r2(total), over_allocated: total > 100 }))
      .sort((a, b) => b.allocated_pct - a.allocated_pct);
    return { utilization, over_allocated_count: utilization.filter((u) => u.over_allocated).length };
  }

  // ── Earned-value management (P4, PROJ-06) ────────────────────────────────
  // Computes BAC / PV / EV / AC → CPI / SPI + cost & schedule variance + EAC/ETC from the project's WBS tasks
  // (planned cost, % complete, planned_end schedule) and its actual cost incurred, and reconciles EV/AC against
  // the project's WIP actuals. `as_of` defaults to the business day; PV counts tasks scheduled to finish by then.
  async evm(code: string, asOf?: string) {
    const db = this.db as any;
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
    const db = this.db as any;
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

  // EVM S-curve: the planned-cost baseline accumulated by month (each task's planned cost lands in its
  // planned_end month), with the current EV/AC/PV snapshot overlaid — the classic planned-vs-actual S-curve.
  async evmSeries(code: string, dto?: { months?: number }) {
    const db = this.db as any;
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
    const db = this.db as any;
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

  // ── Baselines & variance (B1, PROJ-07) ───────────────────────────────────
  // Current planned BAC (Σ non-cancelled task planned cost; falls back to the project budget) + critical-path
  // duration — the figures a baseline snapshots and the current plan is compared against.
  private async currentPlan(code: string, p: any) {
    const db = this.db as any;
    const tasks = (await db.select().from(projectTasks).where(eq(projectTasks.projectId, Number(p.id)))).filter((t: any) => t.status !== 'cancelled');
    let bac = r2(tasks.reduce((s: number, t: any) => s + n(t.plannedCost), 0));
    if (bac === 0) bac = n(p.budgetAmount);
    const sched = await this.schedule(code);
    return { bac, duration_days: sched.project_duration_days };
  }

  // Capture a baseline. The FIRST baseline is free; **re-baselining requires a reason** (BASELINE_REASON_REQUIRED)
  // and supersedes the prior active baseline (history preserved) — a project can't silently move its goalposts.
  async captureBaseline(code: string, dto: BaselineDto, user: JwtUser) {
    const db = this.db as any;
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
    const db = this.db as any;
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

  // ── Project templates (B2) ───────────────────────────────────────────────
  // Create a reusable WBS/milestone scaffold. Items default their seq to declaration order (1-based) so a
  // template can omit explicit seqs; parent_seq / depends_on_seq reference those ordinals.
  async createTemplate(dto: TemplateDto, user: JwtUser) {
    const db = this.db as any;
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
        templateId: Number(tpl.id), tenantId, itemType: it.item_type ?? 'task', seq: it.seq ?? i + 1, name: it.name,
        parentSeq: it.parent_seq ?? null, wbsCode: it.wbs_code ?? null,
        plannedHours: fx(it.planned_hours ?? 0, 2), plannedCost: fx(it.planned_cost ?? 0, 2),
        offsetStartDays: Math.round(n(it.offset_start_days)), offsetEndDays: Math.round(n(it.offset_end_days)),
        dependsOnSeq: depsCsv(it.depends_on_seq),
        billingPercent: it.billing_percent != null ? fx(it.billing_percent, 2) : null,
        owner: it.owner ?? null, assignee: it.assignee ?? null,
      });
    }
    return this.getTemplate(code);
  }

  async listTemplates(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(projectTemplates).orderBy(desc(projectTemplates.id)).limit(200);
    const counts = await db.select({ tid: projectTemplateItems.templateId, c: sql<string>`count(*)` }).from(projectTemplateItems).groupBy(projectTemplateItems.templateId);
    const cBy = new Map<number, number>(counts.map((x: any) => [Number(x.tid), Number(x.c)]));
    return { templates: rows.map((t: any) => ({ id: Number(t.id), code: t.code, name: t.name, description: t.description, status: t.status, item_count: cBy.get(Number(t.id)) ?? 0, created_at: t.createdAt })), count: rows.length };
  }

  async getTemplate(code: string) {
    const db = this.db as any;
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
    const db = this.db as any;
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
      seqToId.set(Number(it.seq), Number(t.id));
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
    const db = this.db as any;
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
    return this.listRisks(code);
  }

  async listRisks(code: string) {
    const db = this.db as any;
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
    const db = this.db as any;
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
    return this.listRisks(proj.projectCode);
  }

  // Portfolio top-risks roll-up (Track A tie-in): every open risk/issue across the caller's projects, ranked by
  // score; `high` are the red (HIGH) ones and `unmitigated_high` the subset with no mitigation plan (PROJ-08).
  async topRisks(user: JwtUser) {
    const db = this.db as any;
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
    const [p] = await (this.db as any).select().from(projects).where(eq(projects.projectCode, code)).limit(1);
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
function shapeBaseline(b: any) {
  return { id: Number(b.id), label: b.label, baseline_bac: n(b.baselineBac), baseline_duration_days: Number(b.baselineDurationDays), baseline_end: b.baselineEnd, reason: b.reason, status: b.status, created_by: b.createdBy, captured_at: b.capturedAt };
}

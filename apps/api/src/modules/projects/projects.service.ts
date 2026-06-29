import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projects, projectEntries, projectTasks, projectMilestones, projectResources, resourceRates, crmOpportunities, customerMaster } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const clampPct = (x: unknown) => Math.max(0, Math.min(100, r2(x)));

export interface CreateProjectDto { project_code?: string; name: string; customer_name?: string; customer_no?: string; billing_type?: 'TM' | 'Fixed'; budget_amount?: number; contract_amount?: number; start_date?: string; end_date?: string }
export interface CostDto { entry_type?: 'time' | 'expense'; description?: string; qty?: number; rate?: number; amount?: number; billable?: boolean; entry_date?: string }
export interface BillDto { amount?: number; percent?: number }
export interface FromOpportunityDto { project_code?: string; billing_type?: 'TM' | 'Fixed'; budget_amount?: number; start_date?: string; end_date?: string }
export interface TaskDto { name: string; parent_id?: number; wbs_code?: string; status?: string; planned_start?: string; planned_end?: string; planned_hours?: number; planned_cost?: number; pct_complete?: number; assignee?: string }
export interface TaskPatchDto { name?: string; status?: string; planned_start?: string; planned_end?: string; planned_hours?: number; planned_cost?: number; pct_complete?: number; assignee?: string }
export interface MilestoneDto { name: string; due_date?: string; owner?: string; billing_percent?: number }
export interface RateCardDto { role: string; cost_rate?: number; bill_rate?: number; effective_from?: string; effective_to?: string }
export interface ResourceDto { resource_name: string; role?: string; task_id?: number; alloc_pct?: number; period_start?: string; period_end?: string }

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly ledger: LedgerService,
  ) {}

  async create(dto: CreateProjectDto, user: JwtUser) {
    const db = this.db as any;
    const code = dto.project_code?.trim() || `PRJ${String(Date.now()).slice(-6)}`;
    await db.insert(projects).values({
      tenantId: user.tenantId ?? null, projectCode: code, name: dto.name, customerName: dto.customer_name ?? null, customerNo: dto.customer_no ?? null,
      billingType: dto.billing_type ?? 'TM', budgetAmount: fx(dto.budget_amount ?? 0, 2), contractAmount: fx(dto.contract_amount ?? 0, 2),
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
      pctComplete: fx(clampPct(dto.pct_complete ?? 0), 2), assignee: dto.assignee ?? null, createdBy: user.username,
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

  private async row(code: string) {
    const [p] = await (this.db as any).select().from(projects).where(eq(projects.projectCode, code)).limit(1);
    if (!p) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${code} not found`, messageTh: 'ไม่พบโครงการ' });
    return p;
  }

  private fmt(p: any, nonBillable = 0) {
    const cost = n(p.costToDate), recognized = n(p.recognizedCost), billed = n(p.billedToDate), nb = r2(nonBillable);
    const budget = n(p.budgetAmount), totalCost = r2(cost + nb);
    return {
      project_code: p.projectCode, name: p.name, customer_name: p.customerName, customer_no: p.customerNo, crm_opp_no: p.crmOppNo, billing_type: p.billingType, status: p.status,
      budget_amount: budget, contract_amount: n(p.contractAmount),
      cost_to_date: cost, recognized_cost: recognized, billed_to_date: billed,
      non_billable_cost: nb,                       // expensed straight to 5800 (unrecoverable)
      total_cost: totalCost,                       // all costs incurred (recoverable WIP + non-billable)
      // Budget control: variance = budget − total cost incurred (negative = OVER budget); budget_used_pct +
      // over_budget flag let the controller catch a cost overrun before it eats the margin (null if no budget).
      budget_variance: budget > 0 ? r2(budget - totalCost) : null,
      budget_used_pct: budget > 0 ? r2((totalCost / budget) * 100) : null,
      over_budget: budget > 0 && totalCost > budget,
      wip: r2(cost - recognized),                  // unbilled BILLABLE cost sitting in 1260
      margin: r2(billed - recognized - nb),        // recognized revenue − recognized billable cost − absorbed non-billable
      // Fixed-price progress: how much of the contract is billed + what's left to bill (null for T&M).
      billed_pct: p.billingType === 'Fixed' && n(p.contractAmount) > 0 ? r2((billed / n(p.contractAmount)) * 100) : null,
      remaining_to_bill: p.billingType === 'Fixed' && n(p.contractAmount) > 0 ? r2(Math.max(0, n(p.contractAmount) - billed)) : null,
      start_date: p.startDate, end_date: p.endDate, created_at: p.createdAt,
    };
  }
}

function shapeTask(t: any) {
  return { id: Number(t.id), project_id: Number(t.projectId), parent_id: t.parentId != null ? Number(t.parentId) : null, wbs_code: t.wbsCode, name: t.name, status: t.status, planned_start: t.plannedStart, planned_end: t.plannedEnd, planned_hours: n(t.plannedHours), planned_cost: n(t.plannedCost), pct_complete: n(t.pctComplete), assignee: t.assignee, created_at: t.createdAt };
}
function shapeMilestone(m: any) {
  return { id: Number(m.id), project_id: Number(m.projectId), name: m.name, due_date: m.dueDate, owner: m.owner, status: m.status, billing_percent: m.billingPercent != null ? n(m.billingPercent) : null, reached_at: m.reachedAt, created_at: m.createdAt };
}
function shapeResource(r: any) {
  return { id: Number(r.id), project_id: Number(r.projectId), task_id: r.taskId != null ? Number(r.taskId) : null, resource_name: r.resourceName, role: r.role, alloc_pct: n(r.allocPct), period_start: r.periodStart, period_end: r.periodEnd, cost_rate: n(r.costRate), bill_rate: n(r.billRate), created_at: r.createdAt };
}

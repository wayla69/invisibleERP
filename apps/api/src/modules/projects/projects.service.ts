import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projects, projectEntries, projectTasks, projectMilestones, projectResources, resourceRates, crmOpportunities, customerMaster } from '../../database/schema';
import { LedgerService } from '../ledger/ledger.service';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;
const r4 = (x: unknown) => Math.round((Number(x) || 0) * 10000) / 10000;
const clampPct = (x: unknown) => Math.max(0, Math.min(100, r2(x)));
const depsCsv = (ids?: number[]) => (ids && ids.length ? ids.map((i) => Number(i)).filter((i) => Number.isFinite(i)).join(',') : null);

export interface CreateProjectDto { project_code?: string; name: string; customer_name?: string; customer_no?: string; billing_type?: 'TM' | 'Fixed'; budget_amount?: number; contract_amount?: number; start_date?: string; end_date?: string }
export interface CostDto { entry_type?: 'time' | 'expense'; description?: string; qty?: number; rate?: number; amount?: number; billable?: boolean; entry_date?: string }
export interface BillDto { amount?: number; percent?: number }
export interface FromOpportunityDto { project_code?: string; billing_type?: 'TM' | 'Fixed'; budget_amount?: number; start_date?: string; end_date?: string }
export interface TaskDto { name: string; parent_id?: number; wbs_code?: string; status?: string; planned_start?: string; planned_end?: string; planned_hours?: number; planned_cost?: number; pct_complete?: number; assignee?: string; depends_on?: number[] }
export interface TaskPatchDto { name?: string; status?: string; planned_start?: string; planned_end?: string; planned_hours?: number; planned_cost?: number; pct_complete?: number; assignee?: string; depends_on?: number[] }
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
      pctComplete: fx(clampPct(dto.pct_complete ?? 0), 2), dependsOn: depsCsv(dto.depends_on), assignee: dto.assignee ?? null, createdBy: user.username,
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
  return { id: Number(t.id), project_id: Number(t.projectId), parent_id: t.parentId != null ? Number(t.parentId) : null, wbs_code: t.wbsCode, name: t.name, status: t.status, planned_start: t.plannedStart, planned_end: t.plannedEnd, planned_hours: n(t.plannedHours), planned_cost: n(t.plannedCost), pct_complete: n(t.pctComplete), depends_on: t.dependsOn ? String(t.dependsOn).split(',').map((x: string) => Number(x)).filter((x: number) => Number.isFinite(x)) : [], assignee: t.assignee, created_at: t.createdAt };
}
function shapeMilestone(m: any) {
  return { id: Number(m.id), project_id: Number(m.projectId), name: m.name, due_date: m.dueDate, owner: m.owner, status: m.status, billing_percent: m.billingPercent != null ? n(m.billingPercent) : null, reached_at: m.reachedAt, created_at: m.createdAt };
}
function shapeResource(r: any) {
  return { id: Number(r.id), project_id: Number(r.projectId), task_id: r.taskId != null ? Number(r.taskId) : null, resource_name: r.resourceName, role: r.role, alloc_pct: n(r.allocPct), period_start: r.periodStart, period_end: r.periodEnd, cost_rate: n(r.costRate), bill_rate: n(r.billRate), created_at: r.createdAt };
}

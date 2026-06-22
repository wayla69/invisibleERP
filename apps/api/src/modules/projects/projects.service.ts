import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { projects, projectTasks, projectTimesheets, projectExpenses, projectMilestones, arInvoices, employees } from '../../database/schema';
import { DocNumberService } from '../../common/doc-number.service';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

export interface ProjectDto { code?: string; name: string; customer_name?: string; status?: string; billing_type?: string; start_date?: string; end_date?: string; cost_budget?: number; revenue_budget?: number; default_bill_rate?: number; manager?: string }
export interface TimesheetDto { project_id: number; task_id?: number; emp_code?: string; work_date?: string; hours: number; billable?: boolean; bill_rate?: number; cost_rate?: number; notes?: string }
export interface ExpenseDto { project_id: number; exp_date?: string; description?: string; amount: number; billable?: boolean; markup_pct?: number; account_code?: string; vendor?: string }
export interface MilestoneDto { project_id: number; name: string; amount: number; due_date?: string }

// Phase 18 — Project Accounting / PSA: projects, tasks, timesheets, expenses, milestones,
// T&M + milestone billing → AR (unbilled work becomes an open AR invoice), and project P&L.
// Billing creates AR invoices only (no direct GL) — mirrors the house-account pattern; AR recognition
// flows through the existing AR process, so no double-posting.
@Injectable()
export class ProjectsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly docNo: DocNumberService) {}

  // ── Projects ──
  async createProject(dto: ProjectDto, user: JwtUser) {
    const db = this.db as any;
    const code = dto.code ?? await this.docNo.nextDaily('PRJ');
    const [r] = await db.insert(projects).values({
      tenantId: user.tenantId ?? null, code, name: dto.name, customerName: dto.customer_name ?? null,
      status: dto.status ?? 'Planning', billingType: dto.billing_type ?? 'TM', startDate: dto.start_date ?? null, endDate: dto.end_date ?? null,
      costBudget: String(dto.cost_budget ?? 0), revenueBudget: String(dto.revenue_budget ?? 0), defaultBillRate: String(dto.default_bill_rate ?? 0),
      manager: dto.manager ?? null, createdBy: user.username,
    }).returning({ id: projects.id });
    return { id: r.id, code, name: dto.name, status: dto.status ?? 'Planning' };
  }
  async listProjects() {
    const db = this.db as any;
    const rows = await db.select().from(projects).orderBy(desc(projects.id));
    return { projects: rows.map((p: any) => ({ id: p.id, code: p.code, name: p.name, customer_name: p.customerName, status: p.status, billing_type: p.billingType, cost_budget: n(p.costBudget), revenue_budget: n(p.revenueBudget), manager: p.manager })), count: rows.length };
  }
  private async project(id: number) {
    const db = this.db as any;
    const [p] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (!p) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Project not found', messageTh: 'ไม่พบโครงการ' });
    return p;
  }
  async setStatus(id: number, status: string) {
    const db = this.db as any;
    await this.project(id);
    await db.update(projects).set({ status }).where(eq(projects.id, id));
    return { id, status };
  }

  // ── Tasks ──
  async createTask(dto: { project_id: number; code?: string; name: string; planned_hours?: number }, user: JwtUser) {
    const db = this.db as any;
    await this.project(dto.project_id);
    const [r] = await db.insert(projectTasks).values({ tenantId: user.tenantId ?? null, projectId: dto.project_id, code: dto.code ?? null, name: dto.name, plannedHours: String(dto.planned_hours ?? 0) }).returning({ id: projectTasks.id });
    return { id: r.id, name: dto.name };
  }

  // ── Timesheets ──
  async logTimesheet(dto: TimesheetDto, user: JwtUser) {
    const db = this.db as any;
    const p = await this.project(dto.project_id);
    if (!(dto.hours > 0)) throw new BadRequestException({ code: 'BAD_HOURS', message: 'hours must be > 0', messageTh: 'จำนวนชั่วโมงไม่ถูกต้อง' });
    let employeeId: number | null = null;
    if (dto.emp_code) { const [e] = await db.select().from(employees).where(eq(employees.empCode, dto.emp_code)).limit(1); employeeId = e?.id ?? null; }
    const billable = dto.billable ?? true;
    const billRate = dto.bill_rate ?? n(p.defaultBillRate);
    const costRate = dto.cost_rate ?? 0;
    const amount = billable ? round2(dto.hours * billRate) : 0;
    const cost = round2(dto.hours * costRate);
    const [r] = await db.insert(projectTimesheets).values({
      tenantId: user.tenantId ?? null, projectId: dto.project_id, taskId: dto.task_id ?? null, employeeId, empCode: dto.emp_code ?? null,
      workDate: dto.work_date ?? ymd(), hours: String(dto.hours), billable, billRate: String(billRate), costRate: String(costRate),
      amount: String(amount), cost: String(cost), status: 'Open', notes: dto.notes ?? null, createdBy: user.username,
    }).returning({ id: projectTimesheets.id });
    return { id: r.id, hours: dto.hours, amount, cost, billable };
  }

  // ── Expenses ──
  async logExpense(dto: ExpenseDto, user: JwtUser) {
    const db = this.db as any;
    await this.project(dto.project_id);
    if (!(dto.amount > 0)) throw new BadRequestException({ code: 'BAD_AMOUNT', message: 'amount must be > 0', messageTh: 'จำนวนเงินไม่ถูกต้อง' });
    const [r] = await db.insert(projectExpenses).values({
      tenantId: user.tenantId ?? null, projectId: dto.project_id, expDate: dto.exp_date ?? ymd(), description: dto.description ?? null,
      amount: String(round2(dto.amount)), billable: dto.billable ?? true, markupPct: String(dto.markup_pct ?? 0), accountCode: dto.account_code ?? null, vendor: dto.vendor ?? null, status: 'Open', createdBy: user.username,
    }).returning({ id: projectExpenses.id });
    return { id: r.id, amount: round2(dto.amount), billable: dto.billable ?? true };
  }

  // ── Milestones ──
  async createMilestone(dto: MilestoneDto, user: JwtUser) {
    const db = this.db as any;
    await this.project(dto.project_id);
    const [r] = await db.insert(projectMilestones).values({ tenantId: user.tenantId ?? null, projectId: dto.project_id, name: dto.name, amount: String(round2(dto.amount)), dueDate: dto.due_date ?? null, status: 'Pending' }).returning({ id: projectMilestones.id });
    return { id: r.id, name: dto.name, amount: round2(dto.amount), status: 'Pending' };
  }

  // ── Billing ──
  // T&M: roll up all Open billable timesheets + expenses into one AR invoice, mark them Billed.
  async billTimeAndMaterials(projectId: number, user: JwtUser) {
    const db = this.db as any;
    const p = await this.project(projectId);
    const ts = await db.select().from(projectTimesheets).where(and(eq(projectTimesheets.projectId, projectId), eq(projectTimesheets.status, 'Open'), eq(projectTimesheets.billable, true)));
    const ex = await db.select().from(projectExpenses).where(and(eq(projectExpenses.projectId, projectId), eq(projectExpenses.status, 'Open'), eq(projectExpenses.billable, true)));
    const tsTotal = round2(ts.reduce((a: number, r: any) => a + n(r.amount), 0));
    const exTotal = round2(ex.reduce((a: number, r: any) => a + n(r.amount) * (1 + n(r.markupPct) / 100), 0));
    const total = round2(tsTotal + exTotal);
    if (total <= 0) throw new BadRequestException({ code: 'NOTHING_TO_BILL', message: 'No unbilled billable items', messageTh: 'ไม่มีรายการที่ตั้งเบิกได้' });
    const invoiceNo = await this.docNo.nextDaily('PINV');
    await db.transaction(async (tx: any) => {
      await tx.insert(arInvoices).values({ invoiceNo, invoiceDate: ymd(), tenantId: user.tenantId ?? null, orderNo: p.code, amount: String(total), paidAmount: '0', status: 'Unpaid', remarks: `T&M ${p.code}`, createdBy: user.username });
      if (ts.length) await tx.update(projectTimesheets).set({ status: 'Billed', invoiceNo }).where(inArray(projectTimesheets.id, ts.map((r: any) => r.id)));
      if (ex.length) await tx.update(projectExpenses).set({ status: 'Billed', invoiceNo }).where(inArray(projectExpenses.id, ex.map((r: any) => r.id)));
    });
    return { invoice_no: invoiceNo, amount: total, timesheets_billed: ts.length, expenses_billed: ex.length };
  }

  async billMilestone(milestoneId: number, user: JwtUser) {
    const db = this.db as any;
    const [m] = await db.select().from(projectMilestones).where(eq(projectMilestones.id, milestoneId)).limit(1);
    if (!m) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Milestone not found', messageTh: 'ไม่พบงวดงาน' });
    if (m.status === 'Billed') throw new BadRequestException({ code: 'ALREADY_BILLED', message: 'Milestone already billed', messageTh: 'งวดงานนี้ตั้งเบิกแล้ว' });
    const p = await this.project(Number(m.projectId));
    const invoiceNo = await this.docNo.nextDaily('PINV');
    await db.transaction(async (tx: any) => {
      await tx.insert(arInvoices).values({ invoiceNo, invoiceDate: ymd(), tenantId: user.tenantId ?? null, orderNo: p.code, amount: String(n(m.amount)), paidAmount: '0', status: 'Unpaid', remarks: `Milestone ${m.name}`, createdBy: user.username });
      await tx.update(projectMilestones).set({ status: 'Billed', invoiceNo, billedAt: new Date() }).where(eq(projectMilestones.id, milestoneId));
    });
    return { invoice_no: invoiceNo, amount: n(m.amount), milestone: m.name };
  }

  // ── P&L / summary ──
  async summary(projectId: number) {
    const db = this.db as any;
    const p = await this.project(projectId);
    const ts = await db.select().from(projectTimesheets).where(eq(projectTimesheets.projectId, projectId));
    const ex = await db.select().from(projectExpenses).where(eq(projectExpenses.projectId, projectId));
    const ms = await db.select().from(projectMilestones).where(eq(projectMilestones.projectId, projectId));
    const inv = await db.select().from(arInvoices).where(eq(arInvoices.orderNo, p.code));

    const laborCost = round2(ts.reduce((a: number, r: any) => a + n(r.cost), 0));
    const expenseCost = round2(ex.reduce((a: number, r: any) => a + n(r.amount), 0));
    const actualCost = round2(laborCost + expenseCost);
    const unbilledLabor = round2(ts.filter((r: any) => r.status === 'Open' && r.billable).reduce((a: number, r: any) => a + n(r.amount), 0));
    const unbilledExp = round2(ex.filter((r: any) => r.status === 'Open' && r.billable).reduce((a: number, r: any) => a + n(r.amount) * (1 + n(r.markupPct) / 100), 0));
    const billed = round2(inv.reduce((a: number, r: any) => a + n(r.amount), 0));
    const hours = round2(ts.reduce((a: number, r: any) => a + n(r.hours), 0));

    return {
      project: { id: p.id, code: p.code, name: p.name, status: p.status, billing_type: p.billingType },
      hours, labor_cost: laborCost, expense_cost: expenseCost, actual_cost: actualCost,
      unbilled: round2(unbilledLabor + unbilledExp), billed, margin: round2(billed - actualCost),
      cost_budget: n(p.costBudget), revenue_budget: n(p.revenueBudget),
      cost_used_pct: n(p.costBudget) > 0 ? round2((actualCost / n(p.costBudget)) * 100) : null,
      milestones: ms.map((m: any) => ({ id: m.id, name: m.name, amount: n(m.amount), status: m.status, invoice_no: m.invoiceNo })),
      invoices: inv.map((r: any) => ({ invoice_no: r.invoiceNo, amount: n(r.amount), status: r.status })),
    };
  }

  async listTimesheets(projectId: number) {
    const db = this.db as any;
    const rows = await db.select().from(projectTimesheets).where(eq(projectTimesheets.projectId, projectId)).orderBy(desc(projectTimesheets.id));
    return { timesheets: rows.map((r: any) => ({ id: r.id, emp_code: r.empCode, work_date: r.workDate, hours: n(r.hours), billable: r.billable, amount: n(r.amount), cost: n(r.cost), status: r.status, invoice_no: r.invoiceNo })), count: rows.length };
  }
}

import { Inject, Injectable, Optional, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees, timesheets, leaveRequests, leaveBalances, projects } from '../../database/schema';
import { ProjectsService } from '../projects/projects.service';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';
import { assertMakerChecker } from '../../common/control-profile';
import { LineNotifyService } from '../messaging/line-notify.service';
import { HcmLeaveService } from './hcm-leave.service';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;

export interface TimesheetDto { emp_code: string; work_date?: string; regular_hours?: number; ot_hours?: number; note?: string; project_code?: string; task_id?: number; billable?: boolean }
export interface LeaveDto { emp_code: string; leave_type?: string; from_date: string; to_date: string; days: number; paid?: boolean; reason?: string }

// HCM — attendance/timesheets (feeds overtime to payroll) + leave (unpaid reduces pay).
@Injectable()
export class HcmService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly projects: ProjectsService,
    // LC-3 (docs/30) — LINE notify: the requester hears the leave decision. Best-effort.
    @Optional() private readonly lineNotify?: LineNotifyService,
    // HR-2 (docs/42) — leave accrual/balances; enforces the HR-02 entitlement gate on requestLeave.
    // @Optional so a partial harness (no HcmLeaveService) still constructs — the gate is then skipped.
    @Optional() private readonly leave?: HcmLeaveService,
  ) {}

  private async emp(code: string) {
    const [e] = await this.db.select().from(employees).where(eq(employees.empCode, code)).limit(1);
    if (!e) throw new NotFoundException({ code: 'EMP_NOT_FOUND', message: `Employee ${code} not found`, messageTh: 'ไม่พบพนักงาน' });
    return e;
  }

  async logTimesheet(dto: TimesheetDto, user: JwtUser) {
    const db = this.db;
    const e = await this.emp(dto.emp_code);
    // Optional project target: resolve the project by code so an approved timesheet can post labor to it (P3).
    let projectId: number | null = null;
    if (dto.project_code) {
      const [p] = await db.select().from(projects).where(eq(projects.projectCode, dto.project_code)).limit(1);
      if (!p) throw new NotFoundException({ code: 'PROJECT_NOT_FOUND', message: `Project ${dto.project_code} not found`, messageTh: 'ไม่พบโครงการ' });
      projectId = Number(p.id);
    }
    const [row] = await db.insert(timesheets).values({
      tenantId: e.tenantId ?? user.tenantId ?? null, employeeId: Number(e.id), workDate: dto.work_date ?? ymd(),
      regularHours: fx(dto.regular_hours ?? 0, 2), otHours: fx(dto.ot_hours ?? 0, 2), note: dto.note ?? null,
      projectId, taskId: dto.task_id ?? null, billable: dto.billable !== false, status: 'Pending', submittedBy: user.username, createdBy: user.username,
    }).returning({ id: timesheets.id });
    return { id: Number(row!.id), emp_code: dto.emp_code, work_date: dto.work_date ?? ymd(), ot_hours: n(dto.ot_hours), project_code: dto.project_code ?? null, status: 'Pending' };
  }

  // Approve a timesheet (maker-checker — PROJ-04). The approver must differ from the submitter (SoD; binds even
  // Admin). On approval, if the timesheet targets a project, its labor cost (total hours × the employee's hourly
  // rate) posts into the project's WIP through the existing authorized PRJ-COST path (billable → 1260, else 5800).
  async approveTimesheet(id: number, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [ts] = await db.select().from(timesheets).where(eq(timesheets.id, Number(id))).limit(1);
    if (!ts) throw new NotFoundException({ code: 'TIMESHEET_NOT_FOUND', message: `Timesheet ${id} not found`, messageTh: 'ไม่พบใบลงเวลา' });
    if (ts.status === 'Approved') return { id: Number(id), status: 'Approved', already: true, entry_no: ts.entryNo ?? null };
    await assertMakerChecker(db, { user, maker: ts.submittedBy, event: 'hcm.timesheet.approve', ref: String(id), reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'The submitter cannot approve their own timesheet', messageTh: 'ผู้บันทึกอนุมัติใบลงเวลาของตนเองไม่ได้' });
    let entryNo: string | null = null;
    let laborCost = 0;
    if (ts.projectId != null) {
      const [p] = await db.select().from(projects).where(eq(projects.id, Number(ts.projectId))).limit(1);
      const [e] = await db.select().from(employees).where(eq(employees.id, Number(ts.employeeId))).limit(1);
      const hours = r2(n(ts.regularHours) + n(ts.otHours));
      const rate = n(e?.hourlyRate);
      laborCost = r2(hours * rate);
      if (p && laborCost > 0) {
        const res: any = await this.projects.logCost(p.projectCode, {
          entry_type: 'time', qty: hours, rate, billable: ts.billable !== false, entry_date: ts.workDate,
          description: `Labor ${e?.empCode ?? ts.employeeId} ${ts.workDate} (timesheet ${id})`,
        }, user);
        entryNo = res?.entry_no ?? null;
      }
    }
    await db.update(timesheets).set({ status: 'Approved', approvedBy: user.username, approvedAt: new Date(), entryNo }).where(eq(timesheets.id, Number(id)));
    return { id: Number(id), status: 'Approved', approved_by: user.username, project_posted: entryNo != null, entry_no: entryNo, labor_cost: laborCost };
  }

  async listTimesheets(empCode: string | undefined, _user: JwtUser) {
    const db = this.db;
    const q = db.select().from(timesheets);
    const rows = empCode ? await q.where(eq(timesheets.employeeId, Number((await this.emp(empCode)).id))).orderBy(desc(timesheets.workDate)).limit(100) : await q.orderBy(desc(timesheets.id)).limit(100);
    // Resolve project ids → codes so the caller sees the PROJ-04 allocation + maker-checker status.
    const projIds = [...new Set(rows.map((r: any) => r.projectId).filter((x: any) => x != null))];
    const codeById = new Map<number, string>();
    if (projIds.length) {
      const ps = await db.select({ id: projects.id, projectCode: projects.projectCode }).from(projects).where(inArray(projects.id, projIds as number[]));
      for (const p of ps) codeById.set(Number(p.id), p.projectCode);
    }
    return { timesheets: rows.map((r: any) => ({ id: Number(r.id), work_date: r.workDate, regular_hours: n(r.regularHours), ot_hours: n(r.otHours), note: r.note, project_code: r.projectId != null ? (codeById.get(Number(r.projectId)) ?? null) : null, task_id: r.taskId != null ? Number(r.taskId) : null, billable: r.billable !== false, status: r.status ?? 'Pending', entry_no: r.entryNo ?? null })), count: rows.length };
  }

  async requestLeave(dto: LeaveDto, user: JwtUser) {
    const db = this.db;
    const e = await this.emp(dto.emp_code);
    if (n(dto.days) <= 0) throw new BadRequestException({ code: 'BAD_DAYS', message: 'days must be positive', messageTh: 'จำนวนวันลาต้องมากกว่าศูนย์' });
    // HR-02 (docs/42) — entitlement gate. When the tenant has CONFIGURED an active leave_type matching this
    // request's leave_type, a paid request beyond the available balance (entitled+accrued+carryover−used−expired)
    // is BLOCKED unless the type allows a negative balance. Unconfigured types (legacy) keep the old free flow.
    const leaveType = dto.leave_type ?? 'annual';
    if (dto.paid !== false && this.leave) {
      const cfg = await this.leave.typeByCode(leaveType, user);
      if (cfg && cfg.allowNegative !== true) {
        const year = String(dto.from_date).slice(0, 4);
        const available = (await this.leave.availableBalance(Number(e.id), leaveType, year)) ?? 0;
        if (n(dto.days) > available)
          throw new BadRequestException({ code: 'INSUFFICIENT_LEAVE_BALANCE', message: `Requested ${n(dto.days)} day(s) exceeds available ${available} for ${leaveType}`, messageTh: `วันลาที่ขอ (${n(dto.days)}) เกินสิทธิ์คงเหลือ (${available})` });
      }
    }
    const [row] = await db.insert(leaveRequests).values({
      tenantId: e.tenantId ?? user.tenantId ?? null, employeeId: Number(e.id), leaveType: dto.leave_type ?? 'annual',
      fromDate: dto.from_date, toDate: dto.to_date, days: fx(dto.days, 2), paid: dto.paid ?? true, status: 'Pending', reason: dto.reason ?? null, createdBy: user.username,
    }).returning({ id: leaveRequests.id });
    return { id: Number(row!.id), emp_code: dto.emp_code, leave_type: dto.leave_type ?? 'annual', days: n(dto.days), paid: dto.paid ?? true, status: 'Pending' };
  }

  async approveLeave(id: number, user: JwtUser, selfApprovalReason?: string | null) {
    const db = this.db;
    const [lr] = await db.select().from(leaveRequests).where(eq(leaveRequests.id, id)).limit(1);
    if (!lr) throw new NotFoundException({ code: 'LEAVE_NOT_FOUND', message: 'Leave request not found', messageTh: 'ไม่พบใบลา' });
    if (lr.status !== 'Pending') return { id, status: lr.status, already: true };
    // Maker-checker (security review M-3): the requester cannot approve their own paid leave (mirrors
    // approveTimesheet's SOD_SELF_APPROVAL). Without this, one holder of the shared exec/users/creditors
    // permission could request leave and self-approve, bumping their own paid-leave balance.
    await assertMakerChecker(db, { user, maker: lr.createdBy, event: 'hcm.leave.approve', ref: String(id), reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'The requester cannot approve their own leave request', messageTh: 'ผู้ยื่นใบลาอนุมัติใบลาของตนเองไม่ได้' });
    await db.update(leaveRequests).set({ status: 'Approved' }).where(eq(leaveRequests.id, id));
    // bump leave-balance "used" for paid leave types
    if (lr.paid !== false) {
      const year = String(lr.fromDate).slice(0, 4);
      const [bal] = await db.select().from(leaveBalances).where(and(eq(leaveBalances.employeeId, Number(lr.employeeId)), eq(leaveBalances.leaveType, lr.leaveType), eq(leaveBalances.year, year))).limit(1);
      if (bal) await db.update(leaveBalances).set({ used: fx(n(bal.used) + n(lr.days), 2) }).where(eq(leaveBalances.id, Number(bal.id)));
      else await db.insert(leaveBalances).values({ tenantId: lr.tenantId, employeeId: Number(lr.employeeId), leaveType: lr.leaveType, year, entitled: fx(0, 2), used: fx(n(lr.days), 2) });
    }
    if (lr.createdBy) await this.lineNotify?.notifyUser(lr.createdBy, lr.tenantId ?? user.tenantId ?? null, `✅ ใบลา #${id} อนุมัติแล้ว (โดย ${user.username}) — ${n(lr.days)} วัน (${lr.fromDate} → ${lr.toDate})`);
    return { id, status: 'Approved', paid: lr.paid !== false, days: n(lr.days) };
  }

  async listLeave(_user: JwtUser) {
    const db = this.db;
    const rows = await db.select().from(leaveRequests).orderBy(desc(leaveRequests.id)).limit(100);
    return { leave_requests: rows.map((r: any) => ({ id: Number(r.id), leave_type: r.leaveType, from_date: r.fromDate, to_date: r.toDate, days: n(r.days), paid: r.paid !== false, status: r.status, reason: r.reason })), count: rows.length };
  }
}

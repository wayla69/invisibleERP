import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees, timesheets, leaveRequests, leaveBalances } from '../../database/schema';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;

export interface TimesheetDto { emp_code: string; work_date?: string; regular_hours?: number; ot_hours?: number; note?: string }
export interface LeaveDto { emp_code: string; leave_type?: string; from_date: string; to_date: string; days: number; paid?: boolean; reason?: string }

// HCM — attendance/timesheets (feeds overtime to payroll) + leave (unpaid reduces pay).
@Injectable()
export class HcmService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async emp(code: string) {
    const [e] = await (this.db as any).select().from(employees).where(eq(employees.empCode, code)).limit(1);
    if (!e) throw new NotFoundException({ code: 'EMP_NOT_FOUND', message: `Employee ${code} not found`, messageTh: 'ไม่พบพนักงาน' });
    return e;
  }

  async logTimesheet(dto: TimesheetDto, user: JwtUser) {
    const db = this.db as any;
    const e = await this.emp(dto.emp_code);
    await db.insert(timesheets).values({
      tenantId: e.tenantId ?? user.tenantId ?? null, employeeId: Number(e.id), workDate: dto.work_date ?? ymd(),
      regularHours: fx(dto.regular_hours ?? 0, 2), otHours: fx(dto.ot_hours ?? 0, 2), note: dto.note ?? null, createdBy: user.username,
    });
    return { emp_code: dto.emp_code, work_date: dto.work_date ?? ymd(), ot_hours: n(dto.ot_hours) };
  }

  async listTimesheets(empCode: string | undefined, _user: JwtUser) {
    const db = this.db as any;
    const q = db.select({ id: timesheets.id, employeeId: timesheets.employeeId, workDate: timesheets.workDate, regularHours: timesheets.regularHours, otHours: timesheets.otHours, note: timesheets.note }).from(timesheets);
    const rows = empCode ? await q.where(eq(timesheets.employeeId, Number((await this.emp(empCode)).id))).orderBy(desc(timesheets.workDate)).limit(100) : await q.orderBy(desc(timesheets.id)).limit(100);
    return { timesheets: rows.map((r: any) => ({ work_date: r.workDate, regular_hours: n(r.regularHours), ot_hours: n(r.otHours), note: r.note })), count: rows.length };
  }

  async requestLeave(dto: LeaveDto, user: JwtUser) {
    const db = this.db as any;
    const e = await this.emp(dto.emp_code);
    if (n(dto.days) <= 0) throw new BadRequestException({ code: 'BAD_DAYS', message: 'days must be positive', messageTh: 'จำนวนวันลาต้องมากกว่าศูนย์' });
    const [row] = await db.insert(leaveRequests).values({
      tenantId: e.tenantId ?? user.tenantId ?? null, employeeId: Number(e.id), leaveType: dto.leave_type ?? 'annual',
      fromDate: dto.from_date, toDate: dto.to_date, days: fx(dto.days, 2), paid: dto.paid ?? true, status: 'Pending', reason: dto.reason ?? null, createdBy: user.username,
    }).returning({ id: leaveRequests.id });
    return { id: Number(row.id), emp_code: dto.emp_code, leave_type: dto.leave_type ?? 'annual', days: n(dto.days), paid: dto.paid ?? true, status: 'Pending' };
  }

  async approveLeave(id: number, user: JwtUser) {
    const db = this.db as any;
    const [lr] = await db.select().from(leaveRequests).where(eq(leaveRequests.id, id)).limit(1);
    if (!lr) throw new NotFoundException({ code: 'LEAVE_NOT_FOUND', message: 'Leave request not found', messageTh: 'ไม่พบใบลา' });
    if (lr.status !== 'Pending') return { id, status: lr.status, already: true };
    await db.update(leaveRequests).set({ status: 'Approved' }).where(eq(leaveRequests.id, id));
    // bump leave-balance "used" for paid leave types
    if (lr.paid !== false) {
      const year = String(lr.fromDate).slice(0, 4);
      const [bal] = await db.select().from(leaveBalances).where(and(eq(leaveBalances.employeeId, Number(lr.employeeId)), eq(leaveBalances.leaveType, lr.leaveType), eq(leaveBalances.year, year))).limit(1);
      if (bal) await db.update(leaveBalances).set({ used: fx(n(bal.used) + n(lr.days), 2) }).where(eq(leaveBalances.id, Number(bal.id)));
      else await db.insert(leaveBalances).values({ tenantId: lr.tenantId, employeeId: Number(lr.employeeId), leaveType: lr.leaveType, year, entitled: fx(0, 2), used: fx(n(lr.days), 2) });
    }
    return { id, status: 'Approved', paid: lr.paid !== false, days: n(lr.days) };
  }

  async listLeave(_user: JwtUser) {
    const db = this.db as any;
    const rows = await db.select().from(leaveRequests).orderBy(desc(leaveRequests.id)).limit(100);
    return { leave_requests: rows.map((r: any) => ({ id: Number(r.id), leave_type: r.leaveType, from_date: r.fromDate, to_date: r.toDate, days: n(r.days), paid: r.paid !== false, status: r.status, reason: r.reason })), count: rows.length };
  }
}

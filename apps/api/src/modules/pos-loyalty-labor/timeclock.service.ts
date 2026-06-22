import { Inject, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq, and, desc, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { timeClock, employees, custPosSales } from '../../database/schema';
import { n, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// P2c — labor time & attendance: clock in/out, hours, and sales-per-labor-hour productivity.
@Injectable()
export class TimeClockService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  private async emp(empCode: string) {
    const db = this.db as any;
    const [e] = await db.select().from(employees).where(eq(employees.empCode, empCode)).limit(1);
    if (!e) throw new NotFoundException({ code: 'NOT_FOUND', message: `Employee ${empCode} not found`, messageTh: 'ไม่พบพนักงาน' });
    return e;
  }

  async clockIn(empCode: string, user: JwtUser) {
    const db = this.db as any;
    const e = await this.emp(empCode);
    const [open] = await db.select().from(timeClock).where(and(eq(timeClock.employeeId, e.id), eq(timeClock.status, 'Open'))).limit(1);
    if (open) throw new BadRequestException({ code: 'ALREADY_IN', message: 'Already clocked in', messageTh: 'ลงเวลาเข้าไว้แล้ว' });
    const [r] = await db.insert(timeClock).values({ tenantId: user.tenantId ?? null, employeeId: e.id, empCode, clockIn: new Date(), status: 'Open', createdBy: user.username }).returning({ id: timeClock.id });
    return { id: r.id, emp_code: empCode, status: 'Open' };
  }

  async clockOut(empCode: string, breakMinutes: number | undefined) {
    const db = this.db as any;
    const e = await this.emp(empCode);
    const [open] = await db.select().from(timeClock).where(and(eq(timeClock.employeeId, e.id), eq(timeClock.status, 'Open'))).orderBy(desc(timeClock.id)).limit(1);
    if (!open) throw new BadRequestException({ code: 'NOT_IN', message: 'Not clocked in', messageTh: 'ยังไม่ได้ลงเวลาเข้า' });
    const out = new Date();
    const brk = breakMinutes ?? 0;
    const hours = round2((out.getTime() - new Date(open.clockIn).getTime()) / 3600000 - brk / 60);
    await db.update(timeClock).set({ clockOut: out, breakMinutes: brk, hours: String(Math.max(0, hours)), status: 'Closed' }).where(eq(timeClock.id, open.id));
    return { id: open.id, emp_code: empCode, hours: Math.max(0, hours), status: 'Closed' };
  }

  async report(limit = 100) {
    const db = this.db as any;
    const rows = await db.select().from(timeClock).where(eq(timeClock.status, 'Closed')).orderBy(desc(timeClock.id)).limit(limit);
    const totalHours = round2(rows.reduce((a: number, r: any) => a + n(r.hours), 0));
    const open = await db.select().from(timeClock).where(eq(timeClock.status, 'Open'));
    return { entries: rows.map((r: any) => ({ id: r.id, emp_code: r.empCode, clock_in: r.clockIn, clock_out: r.clockOut, break_minutes: r.breakMinutes, hours: n(r.hours) })), total_hours: totalHours, open_count: open.length, count: rows.length };
  }

  // Sales-per-labor-hour for a day = Σ sales total / Σ closed labor hours that day.
  async productivity(date?: string) {
    const db = this.db as any;
    const d = date ?? ymd();
    const closed = await db.select().from(timeClock).where(eq(timeClock.status, 'Closed'));
    const hours = round2(closed.filter((r: any) => r.clockIn && ymd(new Date(r.clockIn)) === d).reduce((a: number, r: any) => a + n(r.hours), 0));
    const sales = await db.select().from(custPosSales).where(eq(custPosSales.saleDate, d));
    const totalSales = round2(sales.reduce((a: number, r: any) => a + n(r.total), 0));
    return { date: d, total_sales: totalSales, labor_hours: hours, sales_per_labor_hour: hours > 0 ? round2(totalSales / hours) : null };
  }
}

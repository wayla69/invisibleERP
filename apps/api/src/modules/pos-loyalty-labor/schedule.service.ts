import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { shiftSchedules, timeClock, custPosSales } from '../../database/schema';
import { n, fx } from '../../database/queries';
import { round2 } from '../tax/money';
import type { JwtUser } from '../../common/decorators';

export interface CreateShiftDto { emp_code: string; shift_date: string; start_time: string; end_time: string; hourly_rate?: number; position?: string; notes?: string }

// W4 — shift scheduling / roster + labor %. A planned shift; the labor summary sums scheduled hours × rate,
// compares it to sales (labor % of sales) and to actual punched hours (time_clock). Operational — no GL.
@Injectable()
export class ScheduleService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // hours between two HH:MM times (handles an overnight shift that ends past midnight).
  private hoursBetween(start: string, end: string): number {
    const mins = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
    let d = mins(end) - mins(start);
    if (d < 0) d += 24 * 60; // overnight
    return round2(d / 60);
  }

  async createShift(dto: CreateShiftDto, user: JwtUser) {
    const db = this.db as any;
    if (!/^\d{2}:\d{2}$/.test(dto.start_time) || !/^\d{2}:\d{2}$/.test(dto.end_time)) {
      throw new BadRequestException({ code: 'BAD_TIME', message: 'start_time/end_time must be HH:MM', messageTh: 'เวลาต้องเป็นรูปแบบ HH:MM' });
    }
    const hours = this.hoursBetween(dto.start_time, dto.end_time);
    if (hours <= 0) throw new BadRequestException({ code: 'BAD_SHIFT', message: 'Shift has no duration', messageTh: 'กะงานไม่มีระยะเวลา' });
    const [row] = await db.insert(shiftSchedules).values({
      tenantId: user.tenantId, empCode: dto.emp_code, shiftDate: dto.shift_date, startTime: dto.start_time, endTime: dto.end_time,
      hours: fx(hours, 2), hourlyRate: fx(Math.max(0, n(dto.hourly_rate)), 2), position: dto.position ?? null, status: 'scheduled', notes: dto.notes ?? null, createdBy: user.username,
    }).returning();
    return this.shape(row);
  }

  async list(opts: { from?: string; to?: string }, user: JwtUser) {
    const db = this.db as any;
    const conds = [eq(shiftSchedules.tenantId, user.tenantId as number)];
    if (opts.from) conds.push(gte(shiftSchedules.shiftDate, opts.from));
    if (opts.to) conds.push(lte(shiftSchedules.shiftDate, opts.to));
    const rows = await db.select().from(shiftSchedules).where(and(...conds)).orderBy(asc(shiftSchedules.shiftDate), asc(shiftSchedules.startTime)).limit(1000);
    return { shifts: rows.map((r: any) => this.shape(r)), count: rows.length };
  }

  async cancelShift(id: number, user: JwtUser) {
    const db = this.db as any;
    const [row] = await db.select().from(shiftSchedules).where(and(eq(shiftSchedules.id, id), eq(shiftSchedules.tenantId, user.tenantId as number))).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Shift not found', messageTh: 'ไม่พบกะงาน' });
    await db.update(shiftSchedules).set({ status: 'cancelled' }).where(eq(shiftSchedules.id, id));
    return { id, status: 'cancelled' };
  }

  // Labor summary: scheduled hours/cost (non-cancelled) vs actual punched hours, and labor % of sales.
  async laborSummary(opts: { from: string; to: string }, user: JwtUser) {
    const db = this.db as any;
    const tenantId = user.tenantId as number;
    const shifts = await db.select().from(shiftSchedules).where(and(eq(shiftSchedules.tenantId, tenantId), gte(shiftSchedules.shiftDate, opts.from), lte(shiftSchedules.shiftDate, opts.to), sql`${shiftSchedules.status}::text <> 'cancelled'`));
    const scheduledHours = round2(shifts.reduce((a: number, s: any) => a + n(s.hours), 0));
    const scheduledCost = round2(shifts.reduce((a: number, s: any) => a + n(s.hours) * n(s.hourlyRate), 0));
    // actual punched hours from the time-clock (closed punches) in the window
    const [punched] = await db.select({ v: sql<string>`coalesce(sum(${timeClock.hours}),0)` }).from(timeClock)
      .where(and(eq(timeClock.tenantId, tenantId), sql`${timeClock.status}::text = 'Closed'`, gte(timeClock.clockIn, new Date(opts.from + 'T00:00:00.000Z')), lte(timeClock.clockIn, new Date(opts.to + 'T23:59:59.999Z'))));
    const actualHours = round2(n(punched?.v));
    // sales for the period (business-day sale_date) → labor % of sales
    const [sales] = await db.select({ v: sql<string>`coalesce(sum(${custPosSales.total}),0)` }).from(custPosSales)
      .where(and(eq(custPosSales.tenantId, tenantId), gte(custPosSales.saleDate, opts.from), lte(custPosSales.saleDate, opts.to)));
    const salesTotal = round2(n(sales?.v));
    const laborPct = salesTotal > 0 ? round2((scheduledCost / salesTotal) * 100) : 0;
    // per-staff roll-up
    const byStaff: Record<string, { hours: number; cost: number; shifts: number }> = {};
    for (const sft of shifts) {
      byStaff[sft.empCode] = byStaff[sft.empCode] ?? { hours: 0, cost: 0, shifts: 0 };
      byStaff[sft.empCode].hours = round2(byStaff[sft.empCode].hours + n(sft.hours));
      byStaff[sft.empCode].cost = round2(byStaff[sft.empCode].cost + n(sft.hours) * n(sft.hourlyRate));
      byStaff[sft.empCode].shifts++;
    }
    return {
      from: opts.from, to: opts.to,
      scheduled_hours: scheduledHours, scheduled_cost: scheduledCost, actual_hours: actualHours,
      hours_variance: round2(actualHours - scheduledHours), sales: salesTotal, labor_pct: laborPct,
      by_staff: Object.entries(byStaff).map(([emp_code, v]) => ({ emp_code, ...v })).sort((a, b) => b.cost - a.cost),
    };
  }

  private shape(r: any) {
    return { id: Number(r.id), emp_code: r.empCode, shift_date: r.shiftDate, start_time: r.startTime, end_time: r.endTime, hours: n(r.hours), hourly_rate: n(r.hourlyRate), position: r.position, status: r.status, notes: r.notes, created_by: r.createdBy };
  }
}

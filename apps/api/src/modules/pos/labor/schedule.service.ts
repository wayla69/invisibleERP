import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../../database/database.module';
import { shiftSchedules, timeClock, custPosSales, laborOtRules, laborAlerts } from '../../../database/schema';
import { n, fx } from '../../../database/queries';
import { round2 } from '../../tax/money';
import type { JwtUser } from '../../../common/decorators';

export interface CreateShiftDto { emp_code: string; shift_date: string; start_time: string; end_time: string; hourly_rate?: number; position?: string; notes?: string }

// Thai Labour Protection Act overtime multipliers + statutory caps (the fallback when a tenant has no
// override row). REGULAR_OT 1.5× (beyond 8h/day), HOLIDAY 2× (work on a holiday), HOLIDAY_OT 3× (OT on a
// holiday), NIGHT 1.0× (tracked, no statutory premium). Weekly working-hours cap = 48h.
const THAI_OT_DEFAULTS: Record<string, { multiplier: number; daily: number; weekly: number }> = {
  REGULAR_OT: { multiplier: 1.5, daily: 8, weekly: 48 },
  HOLIDAY: { multiplier: 2.0, daily: 8, weekly: 48 },
  HOLIDAY_OT: { multiplier: 3.0, daily: 8, weekly: 48 },
  NIGHT: { multiplier: 1.0, daily: 8, weekly: 48 },
};
const DEFAULT_LABOR_PCT_TARGET = 35;

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

  // ───────────────────── Step 8: tiered OT rules (Thai LPA) ─────────────────────
  // Effective rules = the statutory defaults overlaid with any per-tenant override rows.
  async getOtRules(user: JwtUser) {
    const db = this.db as any;
    const overrides = await db.select().from(laborOtRules).where(eq(laborOtRules.tenantId, user.tenantId as number));
    const byType = new Map<string, any>(overrides.map((o: any) => [o.ruleType, o]));
    const rules = Object.entries(THAI_OT_DEFAULTS).map(([rule_type, d]) => {
      const o = byType.get(rule_type);
      return {
        rule_type,
        multiplier: o ? n(o.multiplier) : d.multiplier,
        daily_trigger_hours: o ? o.dailyTriggerHours : d.daily,
        weekly_trigger_hours: o ? o.weeklyTriggerHours : d.weekly,
        source: o ? 'override' : 'statutory_default',
      };
    });
    return { rules, weekly_cap_hours: 48 };
  }

  async upsertOtRule(dto: { rule_type: string; multiplier: number; daily_trigger_hours?: number; weekly_trigger_hours?: number }, user: JwtUser) {
    const db = this.db as any;
    if (!THAI_OT_DEFAULTS[dto.rule_type]) throw new BadRequestException({ code: 'BAD_RULE_TYPE', message: 'rule_type must be REGULAR_OT/HOLIDAY/HOLIDAY_OT/NIGHT', messageTh: 'ประเภทกฎ OT ไม่ถูกต้อง' });
    const d = THAI_OT_DEFAULTS[dto.rule_type];
    await db.insert(laborOtRules).values({
      tenantId: user.tenantId, ruleType: dto.rule_type, multiplier: fx(dto.multiplier, 2),
      dailyTriggerHours: dto.daily_trigger_hours ?? d.daily, weeklyTriggerHours: dto.weekly_trigger_hours ?? d.weekly,
    }).onConflictDoUpdate({
      target: [laborOtRules.tenantId, laborOtRules.ruleType],
      set: { multiplier: fx(dto.multiplier, 2), dailyTriggerHours: dto.daily_trigger_hours ?? d.daily, weeklyTriggerHours: dto.weekly_trigger_hours ?? d.weekly },
    });
    return this.getOtRules(user);
  }

  // Compute OT pay for one rule tier, capping the paid hours at the weekly statutory limit (48h) so an
  // entry beyond the cap is flagged, not silently paid.
  async computeOtPay(dto: { rule_type: string; ot_hours: number; hourly_rate: number; week_hours_already?: number }, user: JwtUser) {
    const { rules, weekly_cap_hours } = await this.getOtRules(user);
    const rule = rules.find((r) => r.rule_type === (dto.rule_type || 'REGULAR_OT'));
    if (!rule) throw new BadRequestException({ code: 'BAD_RULE_TYPE', message: 'unknown rule_type', messageTh: 'ประเภทกฎ OT ไม่ถูกต้อง' });
    const already = Math.max(0, n(dto.week_hours_already));
    const otHours = Math.max(0, n(dto.ot_hours));
    const roomToCap = Math.max(0, weekly_cap_hours - already);
    const paidHours = Math.min(otHours, roomToCap);
    const cappedHours = round2(otHours - paidHours);
    const pay = round2(paidHours * Math.max(0, n(dto.hourly_rate)) * rule.multiplier);
    return { rule_type: rule.rule_type, multiplier: rule.multiplier, ot_hours: otHours, paid_hours: round2(paidHours), capped_hours: cappedHours, weekly_cap_hours, over_cap: cappedHours > 0, pay };
  }

  // ───────────────────── Step 8: labor-% alert ─────────────────────
  // Compute the labor summary for a period and, if labor % of sales exceeds the target, persist + return a
  // LABOR_PCT_EXCEEDED alert (idempotent per tenant/period). The manager's "are we over on labor?" check.
  async checkLaborAlert(opts: { from: string; to: string; threshold?: number; branch_id?: number }, user: JwtUser) {
    const db = this.db as any;
    const threshold = opts.threshold != null ? n(opts.threshold) : DEFAULT_LABOR_PCT_TARGET;
    const summary = await this.laborSummary({ from: opts.from, to: opts.to }, user);
    const exceeded = summary.labor_pct > threshold;
    let alert: any = null;
    if (exceeded) {
      const [existing] = await db.select().from(laborAlerts).where(and(
        eq(laborAlerts.tenantId, user.tenantId as number), eq(laborAlerts.periodFrom, opts.from), eq(laborAlerts.periodTo, opts.to),
        sql`${laborAlerts.alertType}::text = 'LABOR_PCT_EXCEEDED'`, sql`${laborAlerts.resolvedAt} is null`,
      )).limit(1);
      if (existing) {
        await db.update(laborAlerts).set({ thresholdPct: fx(threshold, 4), actualPct: fx(summary.labor_pct, 4) }).where(eq(laborAlerts.id, existing.id));
        alert = { ...existing, threshold_pct: threshold, actual_pct: summary.labor_pct };
      } else {
        const [row] = await db.insert(laborAlerts).values({
          tenantId: user.tenantId, branchId: opts.branch_id ?? null, periodFrom: opts.from, periodTo: opts.to,
          alertType: 'LABOR_PCT_EXCEEDED', thresholdPct: fx(threshold, 4), actualPct: fx(summary.labor_pct, 4),
        }).returning();
        alert = row;
      }
    }
    return { ...summary, threshold_pct: threshold, exceeded, alert_id: alert ? Number(alert.id) : null };
  }

  async listAlerts(user: JwtUser, opts?: { resolved?: boolean }) {
    const db = this.db as any;
    const conds = [eq(laborAlerts.tenantId, user.tenantId as number)];
    if (opts?.resolved === false) conds.push(sql`${laborAlerts.resolvedAt} is null`);
    if (opts?.resolved === true) conds.push(sql`${laborAlerts.resolvedAt} is not null`);
    const rows = await db.select().from(laborAlerts).where(and(...conds)).orderBy(asc(laborAlerts.id)).limit(500);
    return { alerts: rows.map((r: any) => ({ id: Number(r.id), branch_id: r.branchId, period_from: r.periodFrom, period_to: r.periodTo, alert_type: r.alertType, threshold_pct: n(r.thresholdPct), actual_pct: n(r.actualPct), resolved_at: r.resolvedAt })), count: rows.length };
  }

  async resolveAlert(id: number, user: JwtUser) {
    const db = this.db as any;
    const [row] = await db.select().from(laborAlerts).where(and(eq(laborAlerts.id, id), eq(laborAlerts.tenantId, user.tenantId as number))).limit(1);
    if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Alert not found', messageTh: 'ไม่พบการแจ้งเตือน' });
    await db.update(laborAlerts).set({ resolvedAt: new Date() }).where(eq(laborAlerts.id, id));
    return { id, resolved: true };
  }

  private shape(r: any) {
    return { id: Number(r.id), emp_code: r.empCode, shift_date: r.shiftDate, start_time: r.startTime, end_time: r.endTime, hours: n(r.hours), hourly_rate: n(r.hourlyRate), position: r.position, status: r.status, notes: r.notes, created_by: r.createdBy };
  }
}

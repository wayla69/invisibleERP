import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees, leaveBalances, leaveTypes, leavePolicies, leaveAccrualRuns } from '../../database/schema';
import { ymd, n, fx } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

const r2 = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;

export interface LeaveTypeDto {
  code: string; name: string; accrual_method?: 'monthly' | 'anniversary' | 'none';
  accrual_rate_days?: number; carryover_cap_days?: number; max_balance_days?: number;
  allow_negative?: boolean; active?: boolean;
}
export interface LeavePolicyDto {
  leave_type_code: string; job_grade?: string | null; min_tenure_months?: number; accrual_rate_days: number;
}

// HR-2 (docs/42) — leave accrual engine + policies. Extends the static leave_balances (entitled/used) with
// an accrued/carryover/expired model driven by leave_types (accrual method + caps) and leave_policies (rate
// override by grade/tenure). The accrual run is idempotent per (tenant, period) and rides the BI scheduler
// (report type hr_leave_accrual). Control HR-02: requestLeave blocks a paid request beyond the available
// balance (enforced in HcmService, which reuses availableBalance here).
@Injectable()
export class HcmLeaveService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // ── Leave-type config ──────────────────────────────────────────────────────
  async listTypes(user: JwtUser) {
    const rows = await this.db.select().from(leaveTypes).orderBy(desc(leaveTypes.id)).limit(200);
    return {
      leave_types: rows.map((t) => ({
        id: Number(t.id), code: t.code, name: t.name, accrual_method: t.accrualMethod,
        accrual_rate_days: n(t.accrualRateDays), carryover_cap_days: n(t.carryoverCapDays),
        max_balance_days: n(t.maxBalanceDays), allow_negative: t.allowNegative === true, active: t.active !== false,
      })),
      count: rows.length,
    };
  }

  async createType(dto: LeaveTypeDto, user: JwtUser) {
    if (!dto.code?.trim()) throw new BadRequestException({ code: 'BAD_CODE', message: 'code is required', messageTh: 'ต้องระบุรหัสประเภทการลา' });
    const method = dto.accrual_method ?? 'none';
    if (!['monthly', 'anniversary', 'none'].includes(method))
      throw new BadRequestException({ code: 'BAD_ACCRUAL_METHOD', message: 'accrual_method must be monthly|anniversary|none', messageTh: 'วิธีสะสมวันลาไม่ถูกต้อง' });
    const [row] = await this.db.insert(leaveTypes).values({
      tenantId: user.tenantId ?? null, code: dto.code.trim(), name: dto.name ?? dto.code.trim(), accrualMethod: method,
      accrualRateDays: fx(dto.accrual_rate_days ?? 0, 4), carryoverCapDays: fx(dto.carryover_cap_days ?? 0, 2),
      maxBalanceDays: fx(dto.max_balance_days ?? 0, 2), allowNegative: dto.allow_negative === true,
      active: dto.active !== false, createdBy: user.username,
    }).returning({ id: leaveTypes.id });
    return { id: Number(row!.id), code: dto.code.trim(), accrual_method: method };
  }

  // ── Leave-policy overrides ──────────────────────────────────────────────────
  async listPolicies(user: JwtUser) {
    const rows = await this.db.select().from(leavePolicies).orderBy(desc(leavePolicies.id)).limit(200);
    const types = await this.db.select().from(leaveTypes);
    const codeById = new Map(types.map((t) => [Number(t.id), t.code]));
    return {
      leave_policies: rows.map((p) => ({
        id: Number(p.id), leave_type_id: Number(p.leaveTypeId), leave_type_code: codeById.get(Number(p.leaveTypeId)) ?? null,
        job_grade: p.jobGrade ?? null, min_tenure_months: Number(p.minTenureMonths ?? 0), accrual_rate_days: n(p.accrualRateDays),
      })),
      count: rows.length,
    };
  }

  async createPolicy(dto: LeavePolicyDto, user: JwtUser) {
    const t = await this.typeByCode(dto.leave_type_code, user);
    if (!t) throw new NotFoundException({ code: 'LEAVE_TYPE_NOT_FOUND', message: `Leave type ${dto.leave_type_code} not found`, messageTh: 'ไม่พบประเภทการลา' });
    const [row] = await this.db.insert(leavePolicies).values({
      tenantId: user.tenantId ?? null, leaveTypeId: Number(t.id), jobGrade: dto.job_grade ?? null,
      minTenureMonths: Math.max(0, Math.trunc(dto.min_tenure_months ?? 0)), accrualRateDays: fx(dto.accrual_rate_days ?? 0, 4), createdBy: user.username,
    }).returning({ id: leavePolicies.id });
    return { id: Number(row!.id), leave_type_code: dto.leave_type_code, job_grade: dto.job_grade ?? null, accrual_rate_days: n(dto.accrual_rate_days) };
  }

  // ── Balances ────────────────────────────────────────────────────────────────
  async balances(empCode: string | undefined, _user: JwtUser) {
    const q = this.db.select().from(leaveBalances);
    let rows;
    if (empCode) {
      const e = await this.empByCode(empCode);
      rows = await this.db.select().from(leaveBalances).where(eq(leaveBalances.employeeId, Number(e.id))).orderBy(desc(leaveBalances.year)).limit(200);
    } else {
      rows = await q.orderBy(desc(leaveBalances.id)).limit(200);
    }
    return {
      balances: rows.map((b) => {
        const available = this.avail(b);
        return {
          id: Number(b.id), employee_id: Number(b.employeeId), leave_type: b.leaveType, leave_type_code: b.leaveTypeCode ?? b.leaveType,
          year: String(b.year), entitled: n(b.entitled), accrued: n(b.accrued), carryover: n(b.carryover),
          used: n(b.used), expired: n(b.expired), available: r2(available),
        };
      }),
      count: rows.length,
    };
  }

  // ── Accrual run (idempotent per tenant+period) ──────────────────────────────
  async runAccrual(user: JwtUser, periodArg?: string) {
    const db = this.db;
    const period = (periodArg && /^\d{4}-\d{2}$/.test(periodArg)) ? periodArg : ymd().slice(0, 7);
    const tenantId = user.tenantId ?? null;
    const year = period.slice(0, 4);

    // Idempotency: one run per (tenant, period). A re-run is a no-op returning the recorded totals.
    const prior = await db.select().from(leaveAccrualRuns).where(and(eqNull(leaveAccrualRuns.tenantId, tenantId), eq(leaveAccrualRuns.period, period))).limit(1);
    if (prior[0]) return { period, already: true, scanned: 0, accrued: n(prior[0].accruedTotal), employees_count: Number(prior[0].employeesCount ?? 0) };

    const types = (await db.select().from(leaveTypes)).filter((t) => t.active !== false && t.accrualMethod !== 'none');
    const emps = (await db.select().from(employees)).filter((e) => e.active !== false);
    const empName = new Set<number>();
    let accruedTotal = 0;

    for (const t of types) {
      const policies = await db.select().from(leavePolicies).where(eq(leavePolicies.leaveTypeId, Number(t.id)));
      const method = t.accrualMethod;
      const maxBal = n(t.maxBalanceDays);
      for (const e of emps) {
        // anniversary accrual only credits in the employee's hire month.
        if (method === 'anniversary' && !this.isAnniversaryMonth(e.startDate, period)) continue;
        const rate = this.resolveRate(t, policies, e, period);
        if (rate <= 0) continue;
        const bal = await this.getOrCreateBalance(Number(e.id), tenantId ?? e.tenantId ?? null, t, year);
        const availBefore = this.avail(bal);
        let add = rate;
        if (maxBal > 0) add = Math.max(0, Math.min(rate, maxBal - availBefore)); // clamp so balance never exceeds max
        if (add <= 0) continue;
        await db.update(leaveBalances).set({ accrued: fx(n(bal.accrued) + add, 2) }).where(eq(leaveBalances.id, Number(bal.id)));
        accruedTotal += add;
        empName.add(Number(e.id));
      }
    }

    await db.insert(leaveAccrualRuns).values({
      tenantId, period, accruedTotal: fx(accruedTotal, 2), employeesCount: empName.size, runBy: user.username,
    });
    return { period, already: false, scanned: emps.length, accrued: r2(accruedTotal), employees_count: empName.size };
  }

  // Available balance for a (employee, leave-type code, year) — used by the HR-02 entitlement gate.
  async availableBalance(employeeId: number, code: string, year: string): Promise<number | null> {
    const rows = await this.db.select().from(leaveBalances).where(and(eq(leaveBalances.employeeId, employeeId), eq(leaveBalances.leaveType, code), eq(leaveBalances.year, year))).limit(1);
    if (!rows[0]) return null;
    return r2(this.avail(rows[0]));
  }

  async typeByCode(code: string, _user: JwtUser) {
    const rows = await this.db.select().from(leaveTypes).where(eq(leaveTypes.active, true)).limit(200);
    return rows.find((t) => t.code.toLowerCase() === code.toLowerCase()) ?? null;
  }

  // ── internals ────────────────────────────────────────────────────────────────
  private avail(b: any) {
    return n(b.entitled) + n(b.accrued) + n(b.carryover) - n(b.used) - n(b.expired);
  }

  private async empByCode(code: string) {
    const [e] = await this.db.select().from(employees).where(eq(employees.empCode, code)).limit(1);
    if (!e) throw new NotFoundException({ code: 'EMP_NOT_FOUND', message: `Employee ${code} not found`, messageTh: 'ไม่พบพนักงาน' });
    return e;
  }

  // Highest matching policy rate by grade + tenure; falls back to the type default.
  private resolveRate(t: any, policies: any[], emp: any, period: string): number {
    const tenure = this.tenureMonths(emp.startDate, period);
    const grade = emp.jobGrade ?? null;
    const matches = policies.filter((p) => (p.jobGrade == null || p.jobGrade === grade) && tenure >= Number(p.minTenureMonths ?? 0));
    if (matches.length) return Math.max(...matches.map((p) => n(p.accrualRateDays)));
    return n(t.accrualRateDays);
  }

  private tenureMonths(startDate: string | null | undefined, period: string): number {
    if (!startDate) return 9999; // unknown hire date → passes any minimum
    const [sy, sm] = String(startDate).slice(0, 7).split('-').map(Number);
    const [py, pm] = period.split('-').map(Number);
    return (Number(py) - Number(sy)) * 12 + (Number(pm) - Number(sm));
  }

  private isAnniversaryMonth(startDate: string | null | undefined, period: string): boolean {
    if (!startDate) return false;
    return String(startDate).slice(5, 7) === period.slice(5, 7);
  }

  // Get the (emp, type.code, year) balance row, creating it if absent and rolling the prior year's remaining
  // balance into carryover (capped at carryover_cap_days); the lost excess is recorded as `expired` on the
  // PRIOR-year row so its balance ties out.
  private async getOrCreateBalance(employeeId: number, tenantId: number | null, t: any, year: string) {
    const code = t.code;
    const existing = await this.db.select().from(leaveBalances).where(and(eq(leaveBalances.employeeId, employeeId), eq(leaveBalances.leaveType, code), eq(leaveBalances.year, year))).limit(1);
    if (existing[0]) return existing[0];

    // New year row — compute carryover from the prior year's remaining balance.
    let carryover = 0;
    const prevYear = String(Number(year) - 1);
    const prevRows = await this.db.select().from(leaveBalances).where(and(eq(leaveBalances.employeeId, employeeId), eq(leaveBalances.leaveType, code), eq(leaveBalances.year, prevYear))).limit(1);
    if (prevRows[0]) {
      const prevAvail = this.avail(prevRows[0]);
      const cap = n(t.carryoverCapDays);
      carryover = Math.max(0, Math.min(prevAvail, cap));
      const lost = Math.max(0, prevAvail - carryover);
      if (lost > 0) await this.db.update(leaveBalances).set({ expired: fx(n(prevRows[0].expired) + lost, 2) }).where(eq(leaveBalances.id, Number(prevRows[0].id)));
    }
    const [row] = await this.db.insert(leaveBalances).values({
      tenantId, employeeId, leaveType: code, leaveTypeCode: code, year, entitled: fx(0, 2), accrued: fx(0, 2),
      carryover: fx(carryover, 2), used: fx(0, 2), expired: fx(0, 2),
    }).returning();
    return row!;
  }
}

// eq that tolerates a NULL tenant (HQ/bypass sessions) — Drizzle's eq(col, null) does not emit IS NULL.
import { isNull } from 'drizzle-orm';
function eqNull(col: any, val: number | null) {
  return val == null ? isNull(col) : eq(col, val);
}

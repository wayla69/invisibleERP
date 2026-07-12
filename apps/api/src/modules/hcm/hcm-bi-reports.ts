import { Inject, Injectable } from '@nestjs/common';
import { eq, and, sql, gte, isNull } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees } from '../../database/schema/payroll';
import { leaveBalances } from '../../database/schema/hcm';
import { hrDepartments, hrPositions, hrAssignments } from '../../database/schema/hcm-org';
import { employeeLifecycle } from '../../database/schema/hcm-lifecycle';
import { payGrades } from '../../database/schema/hcm-comp';
import { n } from '../../database/queries';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import { HcmLeaveService } from './hcm-leave.service';

const round2 = (x: number) => Math.round((Number(x) || 0) * 100) / 100;

// docs/46 Phase 1 — module-owned BI report generators (discovered by BiReportRegistrarService; moved
// verbatim out of bi-generate.service.ts, behaviour identical). HR-2's leave-accrual action job plus
// HR-9 (docs/42 HCM depth, Wave 3, HR-09) workforce analytics: read-only aggregations over the HCM spine.
// Tenant-scoped (explicit tenant filter + RLS): a null-tenant (platform/HQ) session aggregates across
// companies, a tenant session sees only its own rows. All idempotent. The queries now live with the HCM
// schema they read instead of inside BI (docs/46 §4 Phase 1 PR-3).
@Injectable()
export class HcmBiReports implements BiReportSource {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb, private readonly hcmLeave: HcmLeaveService) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        type: 'hr_leave_accrual',
        generate: async (f, user) => {
          const r = await this.hcmLeave.runAccrual(user, f.period || undefined); // idempotent per (tenant, period)
          return { data: r, summary: `Leave accrual ${r.period}: accrued ${r.accrued} day(s) across ${r.employees_count} employee(s)${r.already ? ' (already run)' : ''}`, summaryTh: `สะสมวันลา ${r.period}: ${r.accrued} วัน · ${r.employees_count} คน${r.already ? ' (รันแล้ว)' : ''}` };
        },
      },
      {
        type: 'hr_headcount_trend',
        generate: async (_f, user) => {
          const db = this.db;
          const tid = user.tenantId ?? null;
          const empTenant = tid != null ? eq(employees.tenantId, tid) : sql`true`;
          const asgTenant = tid != null ? eq(hrAssignments.tenantId, tid) : sql`true`;
          // Total active headcount on the payroll identity.
          const [tot] = await db.select({ c: sql<string>`count(*)` }).from(employees).where(and(empTenant, eq(employees.active, true)));
          // Headcount by DEPARTMENT via CURRENT org assignments (end_date IS NULL) → position → department.
          const byDeptRows = await db.select({ department: hrDepartments.name, headcount: sql<string>`count(distinct ${hrAssignments.empCode})` })
            .from(hrAssignments)
            .innerJoin(hrPositions, eq(hrAssignments.positionId, hrPositions.id))
            .innerJoin(hrDepartments, eq(hrPositions.deptId, hrDepartments.id))
            .where(and(asgTenant, isNull(hrAssignments.endDate)))
            .groupBy(hrDepartments.name)
            .orderBy(sql`count(distinct ${hrAssignments.empCode}) desc`);
          // Headcount by POSITION (title) via the same current assignments.
          const byPosRows = await db.select({ position: hrPositions.title, headcount: sql<string>`count(distinct ${hrAssignments.empCode})` })
            .from(hrAssignments)
            .innerJoin(hrPositions, eq(hrAssignments.positionId, hrPositions.id))
            .where(and(asgTenant, isNull(hrAssignments.endDate)))
            .groupBy(hrPositions.title)
            .orderBy(sql`count(distinct ${hrAssignments.empCode}) desc`);
          // Hire-cohort trend (the "by period" dimension): active employees grouped by hire month (start_date).
          const byMonthRows = await db.select({ month: sql<string>`to_char(${employees.startDate}, 'YYYY-MM')`, hires: sql<string>`count(*)` })
            .from(employees)
            .where(and(empTenant, eq(employees.active, true), sql`${employees.startDate} is not null`))
            .groupBy(sql`to_char(${employees.startDate}, 'YYYY-MM')`)
            .orderBy(sql`to_char(${employees.startDate}, 'YYYY-MM')`);
          const total_active = Number(tot?.c ?? 0);
          const by_department = byDeptRows.map((r: any) => ({ department: r.department ?? '—', headcount: Number(r.headcount) }));
          const by_position = byPosRows.map((r: any) => ({ position: r.position ?? '—', headcount: Number(r.headcount) }));
          const by_hire_month = byMonthRows.map((r: any) => ({ month: r.month, hires: Number(r.hires) }));
          const data = { as_of: new Date().toISOString().slice(0, 10), total_active, by_department, by_position, by_hire_month };
          return { data, summary: `Headcount: ${total_active} active across ${by_department.length} department(s), ${by_position.length} position(s)`, summaryTh: `กำลังคน: ${total_active} คน · ${by_department.length} แผนก · ${by_position.length} ตำแหน่ง` };
        },
      },
      {
        type: 'hr_turnover',
        generate: async (f, user) => {
          const db = this.db;
          const tid = user.tenantId ?? null;
          const empTenant = tid != null ? eq(employees.tenantId, tid) : sql`true`;
          const lcTenant = tid != null ? eq(employeeLifecycle.tenantId, tid) : sql`true`;
          const months = Number(f.window_months) > 0 ? Number(f.window_months) : 12;
          const winStart = new Date(); winStart.setMonth(winStart.getMonth() - months);
          // Separations = completed OFFBOARDING lifecycles (HR-5 joiner-mover-leaver) within the window.
          const [sep] = await db.select({ c: sql<string>`count(*)` }).from(employeeLifecycle)
            .where(and(lcTenant, eq(employeeLifecycle.kind, 'offboarding'), eq(employeeLifecycle.status, 'complete'),
              sql`${employeeLifecycle.completedAt} is not null`, gte(employeeLifecycle.completedAt, winStart)));
          const [act] = await db.select({ c: sql<string>`count(*)` }).from(employees).where(and(empTenant, eq(employees.active, true)));
          const [inact] = await db.select({ c: sql<string>`count(*)` }).from(employees).where(and(empTenant, eq(employees.active, false)));
          const separations = Number(sep?.c ?? 0);
          const active = Number(act?.c ?? 0);
          const inactive = Number(inact?.c ?? 0);
          // Average headcount over the window ≈ current active + those who left during it (a beginning-of-window proxy).
          const avg_headcount = active + separations;
          const turnover_pct = avg_headcount > 0 ? round2((separations / avg_headcount) * 100) : 0;
          const data = { as_of: new Date().toISOString().slice(0, 10), window_months: months, window_start: winStart.toISOString().slice(0, 10), separations, active_headcount: active, inactive_headcount: inactive, avg_headcount, turnover_pct };
          return { data, summary: `Turnover (${months}m): ${turnover_pct}% — ${separations} separation(s) vs ${avg_headcount} avg headcount`, summaryTh: `อัตราการลาออก (${months} เดือน): ${turnover_pct}% — ลาออก ${separations} จากกำลังคนเฉลี่ย ${avg_headcount}` };
        },
      },
      {
        type: 'hr_tenure_distribution',
        generate: async (_f, user) => {
          const db = this.db;
          const tid = user.tenantId ?? null;
          const empTenant = tid != null ? eq(employees.tenantId, tid) : sql`true`;
          const rows = await db.select({ empCode: employees.empCode, startDate: employees.startDate })
            .from(employees).where(and(empTenant, eq(employees.active, true)));
          // Tenure buckets computed in-app from start_date (no SQL date math; the row set is small).
          const BUCKETS = [
            { key: '<1y', maxMonths: 12 }, { key: '1-3y', maxMonths: 36 }, { key: '3-5y', maxMonths: 60 },
            { key: '5-10y', maxMonths: 120 }, { key: '10y+', maxMonths: Infinity },
          ] as const;
          const counts: Record<string, number> = { '<1y': 0, '1-3y': 0, '3-5y': 0, '5-10y': 0, '10y+': 0, 'unknown': 0 };
          const now = Date.now();
          let sumMonths = 0, known = 0;
          for (const r of rows) {
            if (!r.startDate) { counts['unknown']!++; continue; }
            const months = Math.max(0, (now - new Date(String(r.startDate) + 'T00:00:00Z').getTime()) / (1000 * 60 * 60 * 24 * 30.4375));
            sumMonths += months; known++;
            const b = BUCKETS.find((x) => months < x.maxMonths) ?? BUCKETS[BUCKETS.length - 1]!;
            counts[b.key] = (counts[b.key] ?? 0) + 1;
          }
          const total = rows.length;
          const buckets = [...BUCKETS.map((b) => ({ bucket: b.key, count: counts[b.key] ?? 0 })), { bucket: 'unknown', count: counts['unknown'] ?? 0 }];
          const avg_tenure_months = known > 0 ? round2(sumMonths / known) : 0;
          const data = { as_of: new Date().toISOString().slice(0, 10), total, avg_tenure_months, buckets };
          return { data, summary: `Tenure: ${total} employee(s), avg ${avg_tenure_months} month(s); ${counts['<1y']} under 1y, ${counts['10y+']} over 10y`, summaryTh: `อายุงาน: ${total} คน · เฉลี่ย ${avg_tenure_months} เดือน · ต่ำกว่า 1 ปี ${counts['<1y']} คน` };
        },
      },
      {
        type: 'hr_comp_ratio',
        generate: async (_f, user) => {
          const db = this.db;
          const tid = user.tenantId ?? null;
          const empTenant = tid != null ? eq(employees.tenantId, tid) : sql`true`;
          // Actual salary vs the employee's pay-grade band (HR-6 pay_grades: min/mid/max). Employees whose
          // job_grade has no band are "ungraded" and excluded from the comp-ratio maths (surfaced in the count).
          const [act] = await db.select({ c: sql<string>`count(*)` }).from(employees).where(and(empTenant, eq(employees.active, true)));
          const rows = await db.select({
            empCode: employees.empCode, grade: employees.jobGrade, salary: employees.monthlySalary,
            minSalary: payGrades.minSalary, midSalary: payGrades.midSalary, maxSalary: payGrades.maxSalary,
          }).from(employees)
            .innerJoin(payGrades, and(eq(employees.jobGrade, payGrades.gradeCode), tid != null ? eq(payGrades.tenantId, tid) : sql`true`))
            .where(and(empTenant, eq(employees.active, true)));
          const byGrade: Record<string, { grade: string; headcount: number; min_band: number; midpoint: number; max_band: number; sumRatio: number }> = {};
          const outOfBand: { emp_code: string; grade: string; salary: number; comp_ratio: number; flag: 'below' | 'above' }[] = [];
          let sumRatioAll = 0;
          for (const r of rows) {
            const salary = n(r.salary);
            const min = n(r.minSalary), max = n(r.maxSalary);
            // Midpoint: the band's mid_salary, falling back to (min+max)/2 when a band left mid at 0.
            const mid = n(r.midSalary) > 0 ? n(r.midSalary) : (min + max) / 2;
            const ratio = mid > 0 ? round2(salary / mid) : 0;
            sumRatioAll += ratio;
            const g = String(r.grade);
            byGrade[g] ??= { grade: g, headcount: 0, min_band: min, midpoint: mid, max_band: max, sumRatio: 0 };
            byGrade[g]!.headcount++; byGrade[g]!.sumRatio += ratio;
            if (max > 0 && salary > max) outOfBand.push({ emp_code: String(r.empCode), grade: g, salary, comp_ratio: ratio, flag: 'above' });
            else if (min > 0 && salary < min) outOfBand.push({ emp_code: String(r.empCode), grade: g, salary, comp_ratio: ratio, flag: 'below' });
          }
          const count_rated = rows.length;
          const by_grade = Object.values(byGrade).map((x) => ({ grade: x.grade, headcount: x.headcount, min_band: round2(x.min_band), midpoint: round2(x.midpoint), max_band: round2(x.max_band), avg_comp_ratio: x.headcount > 0 ? round2(x.sumRatio / x.headcount) : 0 }));
          const avg_comp_ratio = count_rated > 0 ? round2(sumRatioAll / count_rated) : 0;
          const ungraded = Math.max(0, Number(act?.c ?? 0) - count_rated);
          const data = { as_of: new Date().toISOString().slice(0, 10), count_rated, ungraded, avg_comp_ratio, employees_out_of_band: outOfBand.length, by_grade, out_of_band: outOfBand };
          return { data, summary: `Comp ratio: ${count_rated} rated, avg ${avg_comp_ratio}, ${outOfBand.length} out-of-band`, summaryTh: `อัตราค่าตอบแทน: ${count_rated} คน · เฉลี่ย ${avg_comp_ratio} · นอกกรอบ ${outOfBand.length} คน` };
        },
      },
      {
        type: 'hr_leave_liability',
        generate: async (f, user) => {
          const db = this.db;
          const tid = user.tenantId ?? null;
          const lbTenant = tid != null ? eq(leaveBalances.tenantId, tid) : sql`true`;
          // Accrued-but-untaken days per balance = entitled + accrued + carryover − used − expired (floored at 0),
          // valued at the employee's daily rate (monthly_salary ÷ working days/month, default 22).
          const workingDays = Number(f.working_days) > 0 ? Number(f.working_days) : 22;
          const rows = await db.select({
            empCode: employees.empCode, leaveType: leaveBalances.leaveType, salary: employees.monthlySalary,
            entitled: leaveBalances.entitled, used: leaveBalances.used, accrued: leaveBalances.accrued,
            carryover: leaveBalances.carryover, expired: leaveBalances.expired,
          }).from(leaveBalances)
            .innerJoin(employees, eq(leaveBalances.employeeId, employees.id))
            .where(and(lbTenant, eq(employees.active, true)));
          const byType: Record<string, { leave_type: string; days: number; liability: number }> = {};
          const byEmp: Record<string, { emp_code: string; days: number; liability: number }> = {};
          let total_days = 0, total_liability = 0;
          for (const r of rows) {
            const avail = Math.max(0, n(r.entitled) + n(r.accrued) + n(r.carryover) - n(r.used) - n(r.expired));
            if (avail <= 0) continue;
            const perDay = workingDays > 0 ? n(r.salary) / workingDays : 0;
            const liab = round2(avail * perDay);
            total_days = round2(total_days + avail);
            total_liability = round2(total_liability + liab);
            const lt = String(r.leaveType ?? '—');
            byType[lt] ??= { leave_type: lt, days: 0, liability: 0 };
            byType[lt]!.days = round2(byType[lt]!.days + avail); byType[lt]!.liability = round2(byType[lt]!.liability + liab);
            const ec = String(r.empCode ?? '—');
            byEmp[ec] ??= { emp_code: ec, days: 0, liability: 0 };
            byEmp[ec]!.days = round2(byEmp[ec]!.days + avail); byEmp[ec]!.liability = round2(byEmp[ec]!.liability + liab);
          }
          const by_leave_type = Object.values(byType).sort((a, b) => b.liability - a.liability);
          const by_employee = Object.values(byEmp).sort((a, b) => b.liability - a.liability).slice(0, 50);
          const data = { as_of: new Date().toISOString().slice(0, 10), working_days_per_month: workingDays, total_untaken_days: total_days, total_liability, by_leave_type, by_employee };
          return { data, summary: `Leave liability: ${total_liability} THB over ${total_days} untaken day(s) across ${by_employee.length} employee(s)`, summaryTh: `ภาระวันลาสะสม: ${total_liability} บาท · ${total_days} วันคงค้าง · ${by_employee.length} คน` };
        },
      },
    ];
  }
}

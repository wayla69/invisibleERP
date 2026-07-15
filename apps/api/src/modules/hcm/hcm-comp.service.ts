import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { eq, and, desc, isNull, type SQL } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees, payGrades, compChanges, benefitPlans, benefitEnrollments } from '../../database/schema';
import { StatusLogService } from '../../common/status-log.service';
import { isUniqueViolation } from '../../common/db-error';
import { assertMakerChecker } from '../../common/control-profile';
import { n, fx, ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface PayGradeDto { grade_code: string; name: string; min_salary?: number; mid_salary?: number; max_salary?: number; currency?: string; active?: boolean }
export interface CompChangeDto { emp_code: string; change_type: 'hire' | 'merit' | 'promotion' | 'adjustment'; new_salary: number; new_grade?: string; effective_date?: string; reason?: string; override?: boolean }
export interface BenefitPlanDto { plan_code: string; name: string; category: 'health' | 'dental' | 'life' | 'provident_fund' | 'allowance'; employer_cost?: number; employee_cost?: number; active?: boolean }
export interface EnrollmentDto { emp_code: string; plan_code: string; enrolled_date?: string }

// HR-6 (docs/42, Wave 2) — Compensation bands + benefits on the payroll.employees identity (emp_code).
// Control HR-06 (comp-change maker-checker within band): a comp change whose new_salary falls OUTSIDE the
// target pay grade's [min,max] band is blocked at request time (OUT_OF_BAND) unless an hr_admin/exec sets an
// explicit `override` flag (audit-logged). Approval is maker-checker — approved_by MUST differ from
// requested_by (SOD_SELF_APPROVAL) and only hr_admin/exec approve; the employee-salary/grade write happens
// ONLY on approval (never at request).
const HR_READ = ['hr', 'hr_admin', 'exec'];

@Injectable()
export class HcmCompService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly statusLog: StatusLogService,
  ) {}

  private canOverride(user: JwtUser): boolean {
    return user.role === 'Admin' || (user.permissions ?? []).some((p) => p === 'hr_admin' || p === 'exec');
  }
  private isHr(user: JwtUser): boolean {
    return user.role === 'Admin' || (user.permissions ?? []).some((p) => HR_READ.includes(p));
  }
  private async callerEmpCode(user: JwtUser): Promise<string | null> {
    const [e] = await this.db.select({ empCode: employees.empCode }).from(employees).where(eq(employees.userName, user.username)).limit(1);
    return e?.empCode ?? null;
  }
  private async emp(code: string) {
    const [e] = await this.db.select().from(employees).where(eq(employees.empCode, code)).limit(1);
    if (!e) throw new NotFoundException({ code: 'EMP_NOT_FOUND', message: `Employee ${code} not found`, messageTh: 'ไม่พบพนักงาน' });
    return e;
  }
  private async gradeByCode(code: string) {
    const [g] = await this.db.select().from(payGrades).where(eq(payGrades.gradeCode, code)).limit(1);
    if (!g) throw new NotFoundException({ code: 'GRADE_NOT_FOUND', message: `Pay grade ${code} not found`, messageTh: 'ไม่พบระดับเงินเดือน' });
    return g;
  }

  // ── Pay grades ─────────────────────────────────────────────────────────────
  async listGrades(_user: JwtUser) {
    const rows = await this.db.select().from(payGrades).orderBy(payGrades.gradeCode);
    return {
      grades: rows.map((r) => ({
        id: Number(r.id), grade_code: r.gradeCode, name: r.name,
        min_salary: n(r.minSalary), mid_salary: n(r.midSalary), max_salary: n(r.maxSalary),
        currency: r.currency, active: r.active !== false,
      })),
      count: rows.length,
    };
  }

  async createGrade(dto: PayGradeDto, user: JwtUser) {
    const min = n(dto.min_salary), mid = n(dto.mid_salary), max = n(dto.max_salary);
    if (min < 0 || mid < 0 || max < 0) throw new BadRequestException({ code: 'BAD_BAND', message: 'Band salaries must be ≥ 0', messageTh: 'ช่วงเงินเดือนต้องไม่ติดลบ' });
    if (max > 0 && min > max) throw new BadRequestException({ code: 'BAD_BAND', message: 'min_salary must be ≤ max_salary', messageTh: 'เงินเดือนขั้นต่ำต้องไม่มากกว่าขั้นสูง' });
    try {
      const [row] = await this.db.insert(payGrades).values({
        tenantId: user.tenantId ?? null, gradeCode: dto.grade_code, name: dto.name,
        minSalary: fx(min, 2), midSalary: fx(mid, 2), maxSalary: fx(max, 2),
        currency: dto.currency ?? 'THB', active: dto.active !== false,
      }).returning({ id: payGrades.id });
      return { id: Number(row!.id), grade_code: dto.grade_code, name: dto.name, min_salary: min, mid_salary: mid, max_salary: max };
    } catch (e) {
      if (isUniqueViolation(e))
        throw new BadRequestException({ code: 'GRADE_EXISTS', message: `Pay grade ${dto.grade_code} already exists`, messageTh: 'รหัสระดับเงินเดือนซ้ำ' });
      throw e;
    }
  }

  // ── Comp changes (HR-06 band + maker-checker) ──────────────────────────────
  async listChanges(empCode: string | undefined, status: string | undefined, _user: JwtUser) {
    const conds: SQL[] = [];
    if (empCode) conds.push(eq(compChanges.empCode, empCode));
    if (status) conds.push(eq(compChanges.status, status));
    const rows = await this.db.select().from(compChanges).where(conds.length ? and(...conds) : undefined).orderBy(desc(compChanges.id)).limit(200);
    return { changes: rows.map((r) => this.changeOut(r)), count: rows.length };
  }

  private changeOut(r: typeof compChanges.$inferSelect) {
    return {
      id: Number(r.id), emp_code: r.empCode, change_type: r.changeType,
      old_salary: r.oldSalary != null ? n(r.oldSalary) : null, new_salary: n(r.newSalary), new_grade: r.newGrade ?? null,
      effective_date: r.effectiveDate, reason: r.reason ?? null, status: r.status,
      requested_by: r.requestedBy ?? null, approved_by: r.approvedBy ?? null,
    };
  }

  async createChange(dto: CompChangeDto, user: JwtUser) {
    const emp = await this.emp(dto.emp_code);
    const newSalary = n(dto.new_salary);
    if (newSalary < 0) throw new BadRequestException({ code: 'BAD_SALARY', message: 'new_salary must be ≥ 0', messageTh: 'เงินเดือนใหม่ต้องไม่ติดลบ' });

    // HR-06 band check — if a target grade is named, the new salary must fall within its [min,max]. Outside the
    // band is BLOCKED (OUT_OF_BAND) unless the caller holds hr_admin/exec AND sets an explicit override flag.
    let overridden = false;
    if (dto.new_grade) {
      const g = await this.gradeByCode(dto.new_grade);
      const min = n(g.minSalary), max = n(g.maxSalary);
      const outOfBand = (max > 0 && newSalary > max) || newSalary < min;
      if (outOfBand) {
        if (!(dto.override && this.canOverride(user)))
          throw new BadRequestException({
            code: 'OUT_OF_BAND',
            message: `new_salary ${newSalary} is outside pay grade ${dto.new_grade} band [${min}, ${max}]`,
            messageTh: 'เงินเดือนใหม่อยู่นอกช่วงของระดับเงินเดือนเป้าหมาย',
          });
        overridden = true;
      }
    }

    const [row] = await this.db.insert(compChanges).values({
      tenantId: emp.tenantId ?? user.tenantId ?? null, empCode: dto.emp_code, changeType: dto.change_type,
      oldSalary: fx(n(emp.monthlySalary), 2), newSalary: fx(newSalary, 2), newGrade: dto.new_grade ?? null,
      effectiveDate: dto.effective_date ?? ymd(), reason: dto.reason ?? null, status: 'pending', requestedBy: user.username,
    }).returning({ id: compChanges.id });

    // Audit the out-of-band override on the doc status log (HR-06 evidence). The append-only audit_log already
    // captures every mutation via the global AuditInterceptor.
    if (overridden)
      await this.statusLog.log('COMPCHG', String(row!.id), 'Requested', 'Requested', user.username,
        `OUT_OF_BAND_OVERRIDE (HR-06): ${dto.emp_code} → ${newSalary} outside grade ${dto.new_grade}${dto.reason ? ` — ${dto.reason}` : ''}`);

    return {
      id: Number(row!.id), emp_code: dto.emp_code, change_type: dto.change_type, new_salary: newSalary,
      new_grade: dto.new_grade ?? null, status: 'pending', out_of_band_overridden: overridden,
    };
  }

  // HR-06 maker-checker — approved_by MUST differ from requested_by; only hr_admin/exec approve (enforced by
  // the controller). The employee master (monthlySalary + jobGrade) is written ONLY here, on approval.
  // Exception (docs/49): an 'sme' tenant may self-approve WITH self_approval_reason — logged, reviewed by SME-01.
  async approveChange(id: number, user: JwtUser, selfApprovalReason?: string | null) {
    const [r] = await this.db.select().from(compChanges).where(eq(compChanges.id, Number(id))).limit(1);
    if (!r) throw new NotFoundException({ code: 'COMP_CHANGE_NOT_FOUND', message: `Comp change ${id} not found`, messageTh: 'ไม่พบรายการปรับค่าตอบแทน' });
    if (r.status === 'approved') return { id: Number(id), status: 'approved', already: true };
    if (r.status === 'rejected') throw new BadRequestException({ code: 'COMP_CHANGE_REJECTED', message: 'Comp change already rejected', messageTh: 'รายการถูกปฏิเสธแล้ว' });
    await assertMakerChecker(this.db, { user, maker: r.requestedBy, event: 'hcm.comp-change.approve', ref: String(id), reason: selfApprovalReason, code: 'SOD_SELF_APPROVAL', message: 'The requester cannot approve their own comp change', messageTh: 'ผู้ขอไม่สามารถอนุมัติรายการของตนเองได้' });

    await this.db.update(compChanges).set({ status: 'approved', approvedBy: user.username }).where(eq(compChanges.id, Number(id)));
    // Write the new salary/grade to the employee master ONLY on approval.
    const set: Record<string, unknown> = { monthlySalary: fx(n(r.newSalary), 2) };
    if (r.newGrade) set.jobGrade = r.newGrade;
    await this.db.update(employees).set(set).where(eq(employees.empCode, r.empCode));

    return { id: Number(id), status: 'approved', emp_code: r.empCode, new_salary: n(r.newSalary), new_grade: r.newGrade ?? null, approved_by: user.username };
  }

  async rejectChange(id: number, user: JwtUser) {
    const [r] = await this.db.select().from(compChanges).where(eq(compChanges.id, Number(id))).limit(1);
    if (!r) throw new NotFoundException({ code: 'COMP_CHANGE_NOT_FOUND', message: `Comp change ${id} not found`, messageTh: 'ไม่พบรายการปรับค่าตอบแทน' });
    if (r.status === 'approved') throw new BadRequestException({ code: 'COMP_CHANGE_APPROVED', message: 'Comp change already approved', messageTh: 'รายการอนุมัติแล้ว' });
    if (r.status === 'rejected') return { id: Number(id), status: 'rejected', already: true };
    await this.db.update(compChanges).set({ status: 'rejected', approvedBy: user.username }).where(eq(compChanges.id, Number(id)));
    return { id: Number(id), status: 'rejected', emp_code: r.empCode };
  }

  // ── Benefit plans ──────────────────────────────────────────────────────────
  async listBenefitPlans(_user: JwtUser) {
    const rows = await this.db.select().from(benefitPlans).orderBy(benefitPlans.planCode);
    return {
      plans: rows.map((r) => ({
        id: Number(r.id), plan_code: r.planCode, name: r.name, category: r.category,
        employer_cost: n(r.employerCost), employee_cost: n(r.employeeCost), active: r.active !== false,
      })),
      count: rows.length,
    };
  }

  async createBenefitPlan(dto: BenefitPlanDto, user: JwtUser) {
    try {
      const [row] = await this.db.insert(benefitPlans).values({
        tenantId: user.tenantId ?? null, planCode: dto.plan_code, name: dto.name, category: dto.category,
        employerCost: fx(n(dto.employer_cost), 2), employeeCost: fx(n(dto.employee_cost), 2), active: dto.active !== false,
      }).returning({ id: benefitPlans.id });
      return { id: Number(row!.id), plan_code: dto.plan_code, name: dto.name, category: dto.category };
    } catch (e) {
      if (isUniqueViolation(e))
        throw new BadRequestException({ code: 'PLAN_EXISTS', message: `Benefit plan ${dto.plan_code} already exists`, messageTh: 'รหัสสวัสดิการซ้ำ' });
      throw e;
    }
  }

  // ── Benefit enrollments (ess own-scope reads) ──────────────────────────────
  async listEnrollments(empCode: string | undefined, user: JwtUser) {
    // ess-only callers are scoped to their own emp_code; HR/exec see all (or filter by emp_code).
    const own = this.isHr(user) ? empCode : (await this.callerEmpCode(user)) ?? '\x00none';
    const planById = new Map<number, { code: string; name: string }>(
      (await this.db.select().from(benefitPlans)).map((p) => [Number(p.id), { code: p.planCode, name: p.name }]));
    const rows = await this.db.select().from(benefitEnrollments)
      .where(own != null ? eq(benefitEnrollments.empCode, own) : undefined).orderBy(desc(benefitEnrollments.id)).limit(200);
    return {
      enrollments: rows.map((r) => ({
        id: Number(r.id), emp_code: r.empCode, plan_id: Number(r.planId),
        plan_code: planById.get(Number(r.planId))?.code ?? null, plan_name: planById.get(Number(r.planId))?.name ?? null,
        enrolled_date: r.enrolledDate, end_date: r.endDate ?? null, status: r.status, active: r.endDate == null && r.status === 'active',
      })),
      count: rows.length,
    };
  }

  async createEnrollment(dto: EnrollmentDto, user: JwtUser) {
    await this.emp(dto.emp_code);
    const plan = await (async () => {
      const [p] = await this.db.select().from(benefitPlans).where(eq(benefitPlans.planCode, dto.plan_code)).limit(1);
      if (!p) throw new NotFoundException({ code: 'PLAN_NOT_FOUND', message: `Benefit plan ${dto.plan_code} not found`, messageTh: 'ไม่พบแผนสวัสดิการ' });
      return p;
    })();
    // Block a duplicate active enrollment on the same plan.
    const [dup] = await this.db.select({ id: benefitEnrollments.id }).from(benefitEnrollments)
      .where(and(eq(benefitEnrollments.empCode, dto.emp_code), eq(benefitEnrollments.planId, Number(plan.id)), isNull(benefitEnrollments.endDate))).limit(1);
    if (dup) throw new BadRequestException({ code: 'ALREADY_ENROLLED', message: `${dto.emp_code} is already enrolled in ${dto.plan_code}`, messageTh: 'พนักงานลงทะเบียนแผนนี้อยู่แล้ว' });
    const [row] = await this.db.insert(benefitEnrollments).values({
      tenantId: user.tenantId ?? null, empCode: dto.emp_code, planId: Number(plan.id),
      enrolledDate: dto.enrolled_date ?? ymd(), status: 'active',
    }).returning({ id: benefitEnrollments.id });
    return { id: Number(row!.id), emp_code: dto.emp_code, plan_code: dto.plan_code, status: 'active' };
  }

  async endEnrollment(id: number, endDate: string | undefined, _user: JwtUser) {
    const [r] = await this.db.select().from(benefitEnrollments).where(eq(benefitEnrollments.id, Number(id))).limit(1);
    if (!r) throw new NotFoundException({ code: 'ENROLLMENT_NOT_FOUND', message: `Enrollment ${id} not found`, messageTh: 'ไม่พบการลงทะเบียนสวัสดิการ' });
    if (r.status === 'ended') return { id: Number(id), status: 'ended', already: true };
    await this.db.update(benefitEnrollments).set({ status: 'ended', endDate: endDate ?? ymd() }).where(eq(benefitEnrollments.id, Number(id)));
    return { id: Number(id), status: 'ended', end_date: endDate ?? ymd() };
  }
}

import { Inject, Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { eq, and, isNull, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { employees, hrDepartments, hrPositions, hrAssignments } from '../../database/schema';
import { StatusLogService } from '../../common/status-log.service';
import { isUniqueViolation } from '../../common/db-error';
import { ymd } from '../../database/queries';
import type { JwtUser } from '../../common/decorators';

export interface DepartmentDto { dept_code: string; name: string; parent_dept_code?: string; cost_center?: string; manager_emp_code?: string; active?: boolean }
export interface PositionDto { position_code: string; title: string; job_grade?: string; dept_code?: string; reports_to_position_code?: string; budgeted_headcount?: number; active?: boolean }
export interface AssignmentDto { emp_code: string; position_code: string; effective_date?: string; end_date?: string; is_primary?: boolean; override_reason?: string }

// HR-1 (docs/42) — organisation structure, positions & effective-dated assignments on the payroll.employees
// identity (emp_code). Reads gate on hr/hr_admin/exec; writes on hr_admin/exec. The HR-01 headcount-governance
// control lives in createAssignment: an assignment beyond a position's budgeted_headcount is blocked
// (HEADCOUNT_EXCEEDED) unless the caller holds `exec` (override, audit-logged via the doc status log).
@Injectable()
export class HcmOrgService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly statusLog: StatusLogService,
  ) {}

  private canOverride(user: JwtUser): boolean {
    return user.role === 'Admin' || (user.permissions ?? []).includes('exec');
  }

  // ── Departments ──────────────────────────────────────────────────────────
  async listDepartments(user: JwtUser) {
    const rows = await this.db.select().from(hrDepartments).orderBy(hrDepartments.deptCode);
    const byId = new Map<number, string>(rows.map((r) => [Number(r.id), r.deptCode]));
    return {
      departments: rows.map((r) => ({
        id: Number(r.id), dept_code: r.deptCode, name: r.name,
        parent_dept_id: r.parentDeptId != null ? Number(r.parentDeptId) : null,
        parent_dept_code: r.parentDeptId != null ? (byId.get(Number(r.parentDeptId)) ?? null) : null,
        cost_center: r.costCenter ?? null, manager_emp_code: r.managerEmpCode ?? null, active: r.active !== false,
      })),
      count: rows.length,
    };
  }

  async createDepartment(dto: DepartmentDto, user: JwtUser) {
    let parentDeptId: number | null = null;
    if (dto.parent_dept_code) parentDeptId = Number((await this.deptByCode(dto.parent_dept_code)).id);
    try {
      const [row] = await this.db.insert(hrDepartments).values({
        tenantId: user.tenantId ?? null, deptCode: dto.dept_code, name: dto.name, parentDeptId,
        costCenter: dto.cost_center ?? null, managerEmpCode: dto.manager_emp_code ?? null, active: dto.active !== false,
      }).returning({ id: hrDepartments.id });
      return { id: Number(row!.id), dept_code: dto.dept_code, name: dto.name };
    } catch (e) {
      if (isUniqueViolation(e))
        throw new BadRequestException({ code: 'DEPT_EXISTS', message: `Department ${dto.dept_code} already exists`, messageTh: 'รหัสแผนกซ้ำ' });
      throw e;
    }
  }

  private async deptByCode(code: string) {
    const [d] = await this.db.select().from(hrDepartments).where(eq(hrDepartments.deptCode, code)).limit(1);
    if (!d) throw new NotFoundException({ code: 'DEPT_NOT_FOUND', message: `Department ${code} not found`, messageTh: 'ไม่พบแผนก' });
    return d;
  }

  // ── Positions ────────────────────────────────────────────────────────────
  async listPositions(user: JwtUser) {
    const rows = await this.db.select().from(hrPositions).orderBy(hrPositions.positionCode);
    const deptById = new Map<number, string>((await this.db.select({ id: hrDepartments.id, code: hrDepartments.deptCode }).from(hrDepartments)).map((d) => [Number(d.id), d.code]));
    const posById = new Map<number, string>(rows.map((r) => [Number(r.id), r.positionCode]));
    // Active-headcount per position (assignments still in force) so the caller sees vacancy vs the budget.
    const counts = await this.headcountMap();
    return {
      positions: rows.map((r) => ({
        id: Number(r.id), position_code: r.positionCode, title: r.title, job_grade: r.jobGrade ?? null,
        dept_id: r.deptId != null ? Number(r.deptId) : null, dept_code: r.deptId != null ? (deptById.get(Number(r.deptId)) ?? null) : null,
        reports_to_position_id: r.reportsToPositionId != null ? Number(r.reportsToPositionId) : null,
        reports_to_position_code: r.reportsToPositionId != null ? (posById.get(Number(r.reportsToPositionId)) ?? null) : null,
        budgeted_headcount: Number(r.budgetedHeadcount ?? 0), current_headcount: counts.get(Number(r.id)) ?? 0, active: r.active !== false,
      })),
      count: rows.length,
    };
  }

  async createPosition(dto: PositionDto, _user: JwtUser) {
    let deptId: number | null = null;
    if (dto.dept_code) deptId = Number((await this.deptByCode(dto.dept_code)).id);
    let reportsToPositionId: number | null = null;
    if (dto.reports_to_position_code) reportsToPositionId = Number((await this.posByCode(dto.reports_to_position_code)).id);
    const budgeted = dto.budgeted_headcount == null ? 1 : Math.trunc(Number(dto.budgeted_headcount));
    if (budgeted < 0) throw new BadRequestException({ code: 'BAD_HEADCOUNT', message: 'budgeted_headcount must be ≥ 0', messageTh: 'จำนวนอัตราต้องไม่ติดลบ' });
    try {
      const [row] = await this.db.insert(hrPositions).values({
        tenantId: _user.tenantId ?? null, positionCode: dto.position_code, title: dto.title, jobGrade: dto.job_grade ?? null,
        deptId, reportsToPositionId, budgetedHeadcount: budgeted, active: dto.active !== false,
      }).returning({ id: hrPositions.id });
      return { id: Number(row!.id), position_code: dto.position_code, title: dto.title, budgeted_headcount: budgeted };
    } catch (e) {
      if (isUniqueViolation(e))
        throw new BadRequestException({ code: 'POSITION_EXISTS', message: `Position ${dto.position_code} already exists`, messageTh: 'รหัสตำแหน่งซ้ำ' });
      throw e;
    }
  }

  private async posByCode(code: string) {
    const [p] = await this.db.select().from(hrPositions).where(eq(hrPositions.positionCode, code)).limit(1);
    if (!p) throw new NotFoundException({ code: 'POSITION_NOT_FOUND', message: `Position ${code} not found`, messageTh: 'ไม่พบตำแหน่ง' });
    return p;
  }

  // Count of currently-active assignments (end_date IS NULL) per position id.
  private async headcountMap(): Promise<Map<number, number>> {
    const rows = await this.db.select({ positionId: hrAssignments.positionId, c: sql<number>`count(*)::int` })
      .from(hrAssignments).where(isNull(hrAssignments.endDate)).groupBy(hrAssignments.positionId);
    return new Map(rows.map((r) => [Number(r.positionId), Number(r.c)]));
  }

  // ── Assignments (HR-01 headcount governance) ───────────────────────────────
  async listAssignments(positionCode: string | undefined, empCode: string | undefined, _user: JwtUser) {
    const posById = new Map<number, string>((await this.db.select({ id: hrPositions.id, code: hrPositions.positionCode }).from(hrPositions)).map((p) => [Number(p.id), p.code]));
    let where;
    if (positionCode) where = eq(hrAssignments.positionId, Number((await this.posByCode(positionCode)).id));
    else if (empCode) where = eq(hrAssignments.empCode, empCode);
    const q = this.db.select().from(hrAssignments);
    const rows = where ? await q.where(where) : await q;
    return {
      assignments: rows.map((r) => ({
        id: Number(r.id), emp_code: r.empCode, position_id: Number(r.positionId), position_code: posById.get(Number(r.positionId)) ?? null,
        effective_date: r.effectiveDate, end_date: r.endDate ?? null, is_primary: r.isPrimary !== false,
        assigned_by: r.assignedBy ?? null, active: r.endDate == null,
      })),
      count: rows.length,
    };
  }

  async createAssignment(dto: AssignmentDto, user: JwtUser) {
    // Validate the employee exists (on the shared payroll identity — never fork it).
    const [emp] = await this.db.select().from(employees).where(eq(employees.empCode, dto.emp_code)).limit(1);
    if (!emp) throw new NotFoundException({ code: 'EMP_NOT_FOUND', message: `Employee ${dto.emp_code} not found`, messageTh: 'ไม่พบพนักงาน' });
    const pos = await this.posByCode(dto.position_code);

    // HR-01 — headcount governance. The number of currently-active assignments to this position must not reach
    // the budgeted headcount, unless the caller holds `exec` (override, audit-logged). budgeted_headcount = 0
    // is treated as "no cap" (unbudgeted seat) — the control only bites a real budget.
    const budgeted = Number(pos.budgetedHeadcount ?? 0);
    const [{ c: current } = { c: 0 }] = await this.db.select({ c: sql<number>`count(*)::int` })
      .from(hrAssignments).where(and(eq(hrAssignments.positionId, Number(pos.id)), isNull(hrAssignments.endDate)));
    let overridden = false;
    if (budgeted > 0 && Number(current) >= budgeted) {
      if (!this.canOverride(user))
        throw new ForbiddenException({
          code: 'HEADCOUNT_EXCEEDED',
          message: `Position ${dto.position_code} is at its budgeted headcount (${budgeted}); an exec override is required to add another`,
          messageTh: 'ตำแหน่งเต็มอัตรากำลังที่ตั้งไว้ ต้องได้รับอนุมัติจากผู้บริหารเพื่อเพิ่ม',
        });
      overridden = true;
    }

    const [row] = await this.db.insert(hrAssignments).values({
      tenantId: user.tenantId ?? null, empCode: dto.emp_code, positionId: Number(pos.id),
      effectiveDate: dto.effective_date ?? ymd(), endDate: dto.end_date ?? null, isPrimary: dto.is_primary !== false, assignedBy: user.username,
    }).returning({ id: hrAssignments.id });

    // Audit the exec override on the doc status log (HR-01 evidence). Ordinary within-budget assignments are
    // already captured by the append-only audit_log via the global AuditInterceptor.
    if (overridden)
      await this.statusLog.log('HRASSIGN', String(row!.id), 'Blocked', 'Assigned', user.username,
        `HEADCOUNT_OVERRIDE (HR-01): ${dto.position_code} at ${current}/${budgeted}${dto.override_reason ? ` — ${dto.override_reason}` : ''}`);

    return {
      id: Number(row!.id), emp_code: dto.emp_code, position_code: dto.position_code,
      effective_date: dto.effective_date ?? ymd(), is_primary: dto.is_primary !== false,
      headcount_overridden: overridden, budgeted_headcount: budgeted, headcount_before: Number(current),
    };
  }

  // ── Org chart — department + position tree with current assignees ──────────
  async orgChart(user: JwtUser) {
    const depts = await this.db.select().from(hrDepartments).orderBy(hrDepartments.deptCode);
    const positions = await this.db.select().from(hrPositions).orderBy(hrPositions.positionCode);
    const assigns = await this.db.select().from(hrAssignments).where(isNull(hrAssignments.endDate));
    const empRows = await this.db.select({ empCode: employees.empCode, name: employees.name }).from(employees);
    const nameByCode = new Map<string, string>(empRows.map((e) => [e.empCode, e.name ?? e.empCode]));

    const assigneesByPos = new Map<number, { emp_code: string; name: string; is_primary: boolean }[]>();
    for (const a of assigns) {
      const list = assigneesByPos.get(Number(a.positionId)) ?? [];
      list.push({ emp_code: a.empCode, name: nameByCode.get(a.empCode) ?? a.empCode, is_primary: a.isPrimary !== false });
      assigneesByPos.set(Number(a.positionId), list);
    }

    const posNode = (p: typeof positions[number]) => {
      const assignees = assigneesByPos.get(Number(p.id)) ?? [];
      return {
        id: Number(p.id), position_code: p.positionCode, title: p.title, job_grade: p.jobGrade ?? null,
        budgeted_headcount: Number(p.budgetedHeadcount ?? 0), current_headcount: assignees.length,
        vacancies: Math.max(0, Number(p.budgetedHeadcount ?? 0) - assignees.length),
        reports_to_position_id: p.reportsToPositionId != null ? Number(p.reportsToPositionId) : null,
        assignees,
      };
    };

    // Department tree (parent_dept_id) with the positions nested under each department.
    const childrenOf = new Map<number | null, typeof depts>();
    for (const d of depts) {
      const key = d.parentDeptId != null ? Number(d.parentDeptId) : null;
      const arr = childrenOf.get(key) ?? [];
      arr.push(d);
      childrenOf.set(key, arr);
    }
    const posByDept = new Map<number | null, typeof positions>();
    for (const p of positions) {
      const key = p.deptId != null ? Number(p.deptId) : null;
      const arr = posByDept.get(key) ?? [];
      arr.push(p);
      posByDept.set(key, arr);
    }
    const buildDept = (d: typeof depts[number]): any => ({
      id: Number(d.id), dept_code: d.deptCode, name: d.name, cost_center: d.costCenter ?? null, manager_emp_code: d.managerEmpCode ?? null,
      positions: (posByDept.get(Number(d.id)) ?? []).map(posNode),
      children: (childrenOf.get(Number(d.id)) ?? []).map(buildDept),
    });
    const tree = (childrenOf.get(null) ?? []).map(buildDept);
    const unassignedPositions = (posByDept.get(null) ?? []).map(posNode); // positions with no department

    return {
      tree, unassigned_positions: unassignedPositions,
      totals: {
        departments: depts.length, positions: positions.length,
        budgeted_headcount: positions.reduce((s, p) => s + Number(p.budgetedHeadcount ?? 0), 0),
        filled_headcount: assigns.length,
      },
    };
  }
}

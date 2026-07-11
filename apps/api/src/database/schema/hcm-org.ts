import { pgTable, bigserial, bigint, integer, text, boolean, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── HR-1 (docs/42 HCM depth) — Organisation structure, positions & effective-dated assignments ──
// Extends the HCM module on the payroll.employees identity (emp_code is the natural key; no fork of the
// employee master). All three tables are tenant-scoped (RLS + a leading (tenant_id, …) index). The headcount
// governance control HR-01 lives in hcm-org.service.ts (createAssignment): an assignment beyond a position's
// budgeted_headcount is blocked (HEADCOUNT_EXCEEDED) unless an exec overrides (audit-logged).

// Departments — a per-tenant hierarchy (parent_dept_id self-ref) with an optional GL cost-centre link and a
// nominated manager (by emp_code). dept_code is unique per tenant.
export const hrDepartments = pgTable(
  'hr_departments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    deptCode: text('dept_code').notNull(),
    name: text('name').notNull(),
    parentDeptId: bigint('parent_dept_id', { mode: 'number' }), // self-ref (nullable → top-level); cf. projects.ts WBS precedent
    costCenter: text('cost_center'),                            // link to a GL cost centre (free text → cost_centers.code)
    managerEmpCode: text('manager_emp_code'),                   // nominated department manager (payroll.employees.emp_code)
    active: boolean('active').default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uqDept: uniqueIndex('uq_hr_dept_code').on(t.tenantId, t.deptCode),
    byParent: index('idx_hr_dept_parent').on(t.tenantId, t.parentDeptId),
  }),
);

// Positions — budgeted seats within a department, with a reporting line (reports_to_position_id self-ref) and
// a budgeted headcount that the HR-01 control enforces on assignment.
export const hrPositions = pgTable(
  'hr_positions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    positionCode: text('position_code').notNull(),
    title: text('title').notNull(),
    jobGrade: text('job_grade'),
    deptId: bigint('dept_id', { mode: 'number' }).references(() => hrDepartments.id),
    reportsToPositionId: bigint('reports_to_position_id', { mode: 'number' }), // self-ref (nullable → top of the org)
    budgetedHeadcount: integer('budgeted_headcount').notNull().default(1),
    active: boolean('active').default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uqPos: uniqueIndex('uq_hr_position_code').on(t.tenantId, t.positionCode),
    byDept: index('idx_hr_position_dept').on(t.tenantId, t.deptId),
  }),
);

// Assignments — an effective-dated employee → position link. is_primary marks the employee's primary seat.
// A "current active" assignment is one with end_date IS NULL (still in force); that count is what HR-01 checks
// against the position's budgeted_headcount.
export const hrAssignments = pgTable(
  'hr_assignments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    empCode: text('emp_code').notNull(),
    positionId: bigint('position_id', { mode: 'number' }).notNull().references(() => hrPositions.id),
    effectiveDate: date('effective_date').notNull(),
    endDate: date('end_date'),                                 // nullable → still active
    isPrimary: boolean('is_primary').default(true),
    assignedBy: text('assigned_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    byPosition: index('idx_hr_assign_position').on(t.tenantId, t.positionId),
    byEmp: index('idx_hr_assign_emp').on(t.tenantId, t.empCode),
  }),
);

export type HrDepartment = typeof hrDepartments.$inferSelect;
export type HrPosition = typeof hrPositions.$inferSelect;
export type HrAssignment = typeof hrAssignments.$inferSelect;

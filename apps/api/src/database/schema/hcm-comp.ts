import { pgTable, bigserial, bigint, text, numeric, boolean, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── HR-6 (docs/42 HCM depth, Wave 2) — Compensation bands + benefits ──────────────────────────────────────
// Extends the HCM module on the payroll.employees identity (emp_code). All four tables are tenant-scoped (RLS +
// a leading (tenant_id, …) index). The HR-06 comp-change control lives in hcm-comp.service.ts (createChange /
// approveChange): a proposed new salary must fall within the target pay grade's [min,max] band (OUT_OF_BAND
// unless an hr_admin/exec sets an explicit override), and the change is maker-checker — the approver MUST differ
// from the requester (SOD_SELF_APPROVAL), with the employee-salary write happening ONLY on approval.

// Pay grades — a per-tenant salary band register (min/mid/max) that the HR-06 band check enforces. grade_code
// is unique per tenant.
export const payGrades = pgTable(
  'pay_grades',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    gradeCode: text('grade_code').notNull(),
    name: text('name').notNull(),
    minSalary: numeric('min_salary', { precision: 14, scale: 2 }).notNull().default('0'),
    midSalary: numeric('mid_salary', { precision: 14, scale: 2 }).notNull().default('0'),
    maxSalary: numeric('max_salary', { precision: 14, scale: 2 }).notNull().default('0'),
    currency: text('currency').notNull().default('THB'),
    active: boolean('active').default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uqGrade: uniqueIndex('uq_pay_grade_code').on(t.tenantId, t.gradeCode),
  }),
);

// Compensation changes — an effective-dated salary/grade change request on an employee, subject to the HR-06
// band-and-maker-checker control. status pending → approved|rejected; the employee master is written ONLY when
// a DIFFERENT user approves (approved_by ≠ requested_by).
export const compChanges = pgTable(
  'comp_changes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    empCode: text('emp_code').notNull(),
    changeType: text('change_type').notNull(),          // 'hire' | 'merit' | 'promotion' | 'adjustment'
    oldSalary: numeric('old_salary', { precision: 14, scale: 2 }),
    newSalary: numeric('new_salary', { precision: 14, scale: 2 }).notNull(),
    newGrade: text('new_grade'),                        // target pay grade code (drives the band check)
    effectiveDate: date('effective_date').notNull(),
    reason: text('reason'),
    status: text('status').notNull().default('pending'),  // 'pending' | 'approved' | 'rejected'
    requestedBy: text('requested_by'),
    approvedBy: text('approved_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    byEmp: index('idx_comp_change_emp').on(t.tenantId, t.empCode),
    byStatus: index('idx_comp_change_status').on(t.tenantId, t.status),
  }),
);

// Benefit plans — a per-tenant catalogue of benefit offerings with employer/employee monthly cost.
export const benefitPlans = pgTable(
  'benefit_plans',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    planCode: text('plan_code').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull(),               // 'health' | 'dental' | 'life' | 'provident_fund' | 'allowance'
    employerCost: numeric('employer_cost', { precision: 14, scale: 2 }).notNull().default('0'),
    employeeCost: numeric('employee_cost', { precision: 14, scale: 2 }).notNull().default('0'),
    active: boolean('active').default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uqPlan: uniqueIndex('uq_benefit_plan_code').on(t.tenantId, t.planCode),
  }),
);

// Benefit enrollments — an effective-dated employee → plan link (end_date NULL = still active).
export const benefitEnrollments = pgTable(
  'benefit_enrollments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    empCode: text('emp_code').notNull(),
    planId: bigint('plan_id', { mode: 'number' }).notNull().references(() => benefitPlans.id),
    enrolledDate: date('enrolled_date').notNull(),
    endDate: date('end_date'),                          // nullable → still active
    status: text('status').notNull().default('active'),   // 'active' | 'ended'
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    byEmp: index('idx_benefit_enroll_emp').on(t.tenantId, t.empCode),
    byPlan: index('idx_benefit_enroll_plan').on(t.tenantId, t.planId),
  }),
);

export type PayGrade = typeof payGrades.$inferSelect;
export type CompChange = typeof compChanges.$inferSelect;
export type BenefitPlan = typeof benefitPlans.$inferSelect;
export type BenefitEnrollment = typeof benefitEnrollments.$inferSelect;

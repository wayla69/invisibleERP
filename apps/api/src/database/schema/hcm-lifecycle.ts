import { pgTable, bigserial, bigint, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// HR-5 (docs/42 HCM depth) — employee onboarding / offboarding lifecycle (joiner-mover-leaver).
// Checklist templates (onboarding|offboarding) carry ordered tasks; starting a template for an employee
// instantiates a per-employee lifecycle with a copy of the tasks. The HR-05 control lives at completion:
// an OFFBOARDING lifecycle cannot be marked complete while any task flagged is_access_revocation is still
// pending (ACCESS_REVOCATION_INCOMPLETE) — the SOX access-removal-on-termination control. All four tables
// are tenant-scoped: leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation RLS policy
// (applied by the generic DO-loop in migration 0324).

export const onboardingTemplates = pgTable(
  'onboarding_templates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('onboarding'), // onboarding | offboarding
    active: boolean('active').default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_onb_tpl_tenant').on(t.tenantId, t.code) }),
);

export const onboardingTemplateTasks = pgTable(
  'onboarding_template_tasks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    templateId: bigint('template_id', { mode: 'number' }).notNull().references(() => onboardingTemplates.id),
    seq: integer('seq').notNull().default(1),
    title: text('title').notNull(),
    ownerRole: text('owner_role'),                                   // e.g. it | hr | payroll | manager
    category: text('category').notNull().default('docs'),            // it_access | payroll | equipment | docs | training
    isAccessRevocation: boolean('is_access_revocation').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTemplate: index('idx_onb_tpl_task_tpl').on(t.tenantId, t.templateId) }),
);

export const employeeLifecycle = pgTable(
  'employee_lifecycle',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    empCode: text('emp_code').notNull(),
    templateId: bigint('template_id', { mode: 'number' }).references(() => onboardingTemplates.id),
    kind: text('kind').notNull().default('onboarding'),             // onboarding | offboarding
    status: text('status').notNull().default('in_progress'),        // in_progress | complete | blocked
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    startedBy: text('started_by'),
  },
  (t) => ({ byEmp: index('idx_emp_lifecycle_emp').on(t.tenantId, t.empCode) }),
);

export const employeeLifecycleTasks = pgTable(
  'employee_lifecycle_tasks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    lifecycleId: bigint('lifecycle_id', { mode: 'number' }).notNull().references(() => employeeLifecycle.id),
    seq: integer('seq').notNull().default(1),
    title: text('title').notNull(),
    category: text('category').notNull().default('docs'),
    isAccessRevocation: boolean('is_access_revocation').notNull().default(false),
    status: text('status').notNull().default('pending'),            // pending | done | skipped
    doneBy: text('done_by'),
    doneAt: timestamp('done_at', { withTimezone: true }),
    notes: text('notes'),
  },
  (t) => ({ byLifecycle: index('idx_emp_lifecycle_task_lc').on(t.tenantId, t.lifecycleId) }),
);

export type OnboardingTemplate = typeof onboardingTemplates.$inferSelect;
export type EmployeeLifecycle = typeof employeeLifecycle.$inferSelect;
export type EmployeeLifecycleTask = typeof employeeLifecycleTasks.$inferSelect;

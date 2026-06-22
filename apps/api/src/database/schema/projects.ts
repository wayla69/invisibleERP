import { pgTable, bigserial, bigint, text, numeric, boolean, date, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { employees } from './payroll';

// Phase 18 — Project Accounting / PSA.
export const projects = pgTable('projects', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  customerName: text('customer_name'),
  status: text('status').default('Planning'),       // Planning | Active | OnHold | Closed
  billingType: text('billing_type').default('TM'),  // TM | Fixed | Milestone
  startDate: date('start_date'),
  endDate: date('end_date'),
  costBudget: numeric('cost_budget', { precision: 16, scale: 2 }).default('0'),
  revenueBudget: numeric('revenue_budget', { precision: 16, scale: 2 }).default('0'),
  defaultBillRate: numeric('default_bill_rate', { precision: 14, scale: 2 }).default('0'),
  manager: text('manager'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const projectTasks = pgTable('project_tasks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  projectId: bigint('project_id', { mode: 'number' }).references(() => projects.id),
  code: text('code'),
  name: text('name').notNull(),
  plannedHours: numeric('planned_hours', { precision: 12, scale: 2 }).default('0'),
  status: text('status').default('Open'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const projectTimesheets = pgTable('project_timesheets', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  projectId: bigint('project_id', { mode: 'number' }).references(() => projects.id),
  taskId: bigint('task_id', { mode: 'number' }).references(() => projectTasks.id),
  employeeId: bigint('employee_id', { mode: 'number' }).references(() => employees.id),
  empCode: text('emp_code'),
  workDate: date('work_date'),
  hours: numeric('hours', { precision: 10, scale: 2 }).notNull(),
  billable: boolean('billable').default(true),
  billRate: numeric('bill_rate', { precision: 14, scale: 2 }).default('0'),
  costRate: numeric('cost_rate', { precision: 14, scale: 2 }).default('0'),
  amount: numeric('amount', { precision: 16, scale: 2 }).default('0'),
  cost: numeric('cost', { precision: 16, scale: 2 }).default('0'),
  status: text('status').default('Open'),           // Open | Billed
  invoiceNo: text('invoice_no'),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const projectExpenses = pgTable('project_expenses', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  projectId: bigint('project_id', { mode: 'number' }).references(() => projects.id),
  expDate: date('exp_date'),
  description: text('description'),
  amount: numeric('amount', { precision: 16, scale: 2 }).notNull(),
  billable: boolean('billable').default(true),
  markupPct: numeric('markup_pct', { precision: 6, scale: 2 }).default('0'),
  accountCode: text('account_code'),
  vendor: text('vendor'),
  status: text('status').default('Open'),
  invoiceNo: text('invoice_no'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const projectMilestones = pgTable('project_milestones', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  projectId: bigint('project_id', { mode: 'number' }).references(() => projects.id),
  name: text('name').notNull(),
  amount: numeric('amount', { precision: 16, scale: 2 }).default('0'),
  dueDate: date('due_date'),
  status: text('status').default('Pending'),        // Pending | Billed
  invoiceNo: text('invoice_no'),
  billedAt: timestamp('billed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

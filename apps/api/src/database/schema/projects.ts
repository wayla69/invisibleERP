import { pgTable, bigserial, bigint, text, numeric, date, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Project accounting / PPM (โครงการ) — tenant-scoped (RLS). Costs accrue to project WIP; billing
// recognizes revenue + relieves WIP to cost of services. T&M or Fixed-price.
export const projects = pgTable(
  'projects',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    projectCode: text('project_code').notNull(),
    name: text('name').notNull(),
    customerName: text('customer_name'),
    customerNo: text('customer_no'),                          // → customer_master (customer-of-record)
    crmOppNo: text('crm_opp_no'),                             // → crm_opportunities.opp_no (won deal it came from)
    billingType: text('billing_type').notNull().default('TM'), // TM | Fixed
    budgetAmount: numeric('budget_amount', { precision: 16, scale: 2 }).default('0'),
    contractAmount: numeric('contract_amount', { precision: 16, scale: 2 }).default('0'),
    status: text('status').notNull().default('Open'),         // Open | Active | Closed
    costToDate: numeric('cost_to_date', { precision: 16, scale: 2 }).default('0'),
    recognizedCost: numeric('recognized_cost', { precision: 16, scale: 2 }).default('0'),
    billedToDate: numeric('billed_to_date', { precision: 16, scale: 2 }).default('0'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_project_tenant').on(t.tenantId), byCrmOpp: index('idx_project_crm_opp').on(t.crmOppNo) }),
);

// A logged cost (time or expense) against a project.
export const projectEntries = pgTable(
  'project_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    entryType: text('entry_type').notNull().default('time'),  // time | expense
    description: text('description'),
    qty: numeric('qty', { precision: 14, scale: 2 }).default('0'),
    rate: numeric('rate', { precision: 14, scale: 2 }).default('0'),
    amount: numeric('amount', { precision: 16, scale: 2 }).notNull().default('0'),
    billable: boolean('billable').default(true),
    entryDate: date('entry_date'),
    entryNo: text('entry_no'),                                // GL JE for the cost
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byProject: index('idx_pe_project').on(t.projectId) }),
);

// WBS / task breakdown for a project (P1). A task can nest under a parent (work-breakdown hierarchy) and
// carries planned effort/cost + % complete; the project's overall % complete rolls up from its tasks
// (planned-hours-weighted). Operational (non-financial) — no GL impact on its own.
export const projectTasks = pgTable(
  'project_tasks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    parentId: bigint('parent_id', { mode: 'number' }),        // WBS hierarchy (nullable → top-level)
    wbsCode: text('wbs_code'),                                 // e.g. "1.2.3"
    name: text('name').notNull(),
    status: text('status').notNull().default('open'),         // open | in_progress | done | cancelled
    plannedStart: date('planned_start'),
    plannedEnd: date('planned_end'),
    plannedHours: numeric('planned_hours', { precision: 14, scale: 2 }).default('0'),
    plannedCost: numeric('planned_cost', { precision: 16, scale: 2 }).default('0'),
    pctComplete: numeric('pct_complete', { precision: 5, scale: 2 }).default('0'), // 0..100
    assignee: text('assignee'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byProject: index('idx_ptask_project').on(t.projectId), byParent: index('idx_ptask_parent').on(t.parentId) }),
);

// Project milestones (P1). A milestone has a due date/owner/status; an optional billing_percent ties its
// completion to a Fixed-price progress bill (reuses the authorized PRJ-BILL path → PROJ-02).
export const projectMilestones = pgTable(
  'project_milestones',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    name: text('name').notNull(),
    dueDate: date('due_date'),
    owner: text('owner'),
    status: text('status').notNull().default('pending'),      // pending | reached | missed
    billingPercent: numeric('billing_percent', { precision: 5, scale: 2 }), // optional → % of contract to bill on reach
    reachedAt: timestamp('reached_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byProject: index('idx_pmilestone_project').on(t.projectId) }),
);

export type Project = typeof projects.$inferSelect;
export type ProjectTask = typeof projectTasks.$inferSelect;
export type ProjectMilestone = typeof projectMilestones.$inferSelect;

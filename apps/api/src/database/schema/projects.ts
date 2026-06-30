import { pgTable, bigserial, bigint, text, numeric, integer, date, boolean, timestamp, index } from 'drizzle-orm/pg-core';
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
    // Revenue recognition basis (PROJ-09): 'billing' = point-in-time at billing (default, legacy);
    // 'poc' = over-time cost-to-cost (estimated_cost drives the recognised %, accruing 1265/2410).
    revMethod: text('rev_method').notNull().default('billing'),
    estimatedCost: numeric('estimated_cost', { precision: 16, scale: 2 }).default('0'), // total estimated cost (EAC) for POC
    recognizedRevenue: numeric('recognized_revenue', { precision: 16, scale: 2 }).default('0'), // revenue recognised to date (POC)
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
    dependsOn: text('depends_on'),                            // P4 — predecessor task ids (CSV) for scheduling
    assignee: text('assignee'),
    // RACI accountability (B3) — accountable is the single answerable owner; responsible/consulted/informed
    // are CSV lists of people. `assignee` stays for back-compat (a convenience for the primary doer).
    accountable: text('accountable'),
    responsible: text('responsible'),
    consulted: text('consulted'),
    informed: text('informed'),
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

// Resource rate card (P2) — effective-dated cost/bill rate per role. A project resource assignment resolves
// its rate from here, so labor cost/bill estimates are governed by an authorized rate card (PROJ-05).
export const resourceRates = pgTable(
  'resource_rates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    role: text('role').notNull(),                             // e.g. "Senior Dev"
    costRate: numeric('cost_rate', { precision: 14, scale: 2 }).default('0'), // internal cost / hour
    billRate: numeric('bill_rate', { precision: 14, scale: 2 }).default('0'), // billable rate / hour
    effectiveFrom: date('effective_from'),
    effectiveTo: date('effective_to'),                        // nullable → open-ended
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byRole: index('idx_rate_role').on(t.tenantId, t.role) }),
);

// Project resource assignment (P2) — a named resource (role) allocated to a project (optionally a task) for a
// period at an allocation %. The applicable rate-card rates are snapshotted at assignment. Capacity/utilization
// rolls up allocation per resource across projects; >100% flags over-allocation (PROJ-05).
export const projectResources = pgTable(
  'project_resources',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    taskId: bigint('task_id', { mode: 'number' }),            // optional → assignment to a specific WBS task
    resourceName: text('resource_name').notNull(),           // the person / team
    role: text('role'),                                       // → resolves rate card
    allocPct: numeric('alloc_pct', { precision: 5, scale: 2 }).default('100'), // 0..100
    periodStart: date('period_start'),
    periodEnd: date('period_end'),
    costRate: numeric('cost_rate', { precision: 14, scale: 2 }).default('0'),  // snapshot from rate card
    billRate: numeric('bill_rate', { precision: 14, scale: 2 }).default('0'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byProject: index('idx_presource_project').on(t.projectId), byResource: index('idx_presource_name').on(t.tenantId, t.resourceName) }),
);

// Project baseline (B1) — a change-controlled snapshot of the approved plan (BAC + schedule duration) at a
// point in time. Re-baselining requires a reason and preserves history (status active→superseded); variance
// of the current plan vs the active baseline surfaces scope/cost creep (PROJ-07).
export const projectBaselines = pgTable(
  'project_baselines',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    label: text('label'),
    baselineBac: numeric('baseline_bac', { precision: 16, scale: 2 }).default('0'),  // budget at completion
    baselineDurationDays: integer('baseline_duration_days').default(0),               // critical-path duration
    baselineEnd: date('baseline_end'),
    reason: text('reason'),                                  // required when re-baselining (PROJ-07)
    status: text('status').notNull().default('active'),      // active | superseded
    createdBy: text('created_by'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byProject: index('idx_pbaseline_project').on(t.projectId) }),
);

// Project template (B2) — a reusable WBS/milestone scaffold. Applying a template to a project spins up its
// standard task + milestone set in one step, dated relative to the project start. Operational — no GL impact.
export const projectTemplates = pgTable(
  'project_templates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    code: text('code').notNull(),                             // business key (e.g. "IMPL-STD")
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('active'),       // active | archived
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_ptemplate_tenant').on(t.tenantId) }),
);

// A template item scaffolds either a task or a milestone. `seq` is the in-template ordinal that parent_seq /
// depends_on_seq reference (resolved to real ids at apply time); dates are RELATIVE day-offsets from the
// project start so one template fits any start date.
export const projectTemplateItems = pgTable(
  'project_template_items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    templateId: bigint('template_id', { mode: 'number' }).notNull().references(() => projectTemplates.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    itemType: text('item_type').notNull().default('task'),    // task | milestone
    seq: integer('seq').notNull().default(0),
    name: text('name').notNull(),
    parentSeq: integer('parent_seq'),                         // WBS nesting (references another item's seq)
    wbsCode: text('wbs_code'),
    plannedHours: numeric('planned_hours', { precision: 14, scale: 2 }).default('0'),
    plannedCost: numeric('planned_cost', { precision: 16, scale: 2 }).default('0'),
    offsetStartDays: integer('offset_start_days').default(0), // days after project start
    offsetEndDays: integer('offset_end_days').default(0),
    dependsOnSeq: text('depends_on_seq'),                     // CSV of predecessor seqs (finish-to-start)
    billingPercent: numeric('billing_percent', { precision: 5, scale: 2 }), // milestone billing trigger
    owner: text('owner'),                                     // milestone owner
    assignee: text('assignee'),                               // task assignee
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTemplate: index('idx_ptemplate_item_template').on(t.templateId) }),
);

// Project risk & issue register (B4, PROJ-08) — a risk (future threat, scored probability × impact) or an
// issue (materialised problem, scored by impact). RAG + owner + mitigation + due date drive governance: an
// open HIGH risk that is unmitigated is surfaced for review (detective control), never silently buried.
export const projectRisks = pgTable(
  'project_risks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    kind: text('kind').notNull().default('risk'),             // risk | issue
    title: text('title').notNull(),
    status: text('status').notNull().default('open'),         // open | mitigating | closed
    probability: integer('probability'),                      // 1..5 (risks; null for issues)
    impact: integer('impact').notNull().default(1),           // 1..5
    score: integer('score').notNull().default(1),             // 1..25
    rag: text('rag').notNull().default('green'),              // red | amber | green
    owner: text('owner'),
    mitigation: text('mitigation'),
    dueDate: date('due_date'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => ({ byProject: index('idx_prisk_project').on(t.projectId) }),
);

// Project change order (contract/scope variation) — a governed, maker-checker amendment to the contract
// value / budget / EAC. A request posts nothing; a different user approves it, applying the deltas and
// auto-capturing a new baseline (PROJ-10, ties to PROJ-07).
export const projectChangeOrders = pgTable(
  'project_change_orders',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    coNo: text('co_no').notNull(),
    description: text('description'),
    contractDelta: numeric('contract_delta', { precision: 16, scale: 2 }).notNull().default('0'),
    budgetDelta: numeric('budget_delta', { precision: 16, scale: 2 }).notNull().default('0'),
    estimatedCostDelta: numeric('estimated_cost_delta', { precision: 16, scale: 2 }).notNull().default('0'),
    reason: text('reason'),
    status: text('status').notNull().default('pending'),  // pending | approved | rejected
    requestedBy: text('requested_by'),
    approvedBy: text('approved_by'),                       // checker — must differ from requested_by
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
  },
  (t) => ({ byProject: index('idx_pco_project').on(t.projectId) }),
);

// Periodic project-health snapshot (PPM upgrade) — a dated EVM/RAG point so the portfolio/status report can
// show a trajectory (the live EVM is point-in-time). Captured on demand or by the scheduled BI action job.
export const projectHealthSnapshots = pgTable(
  'project_health_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    snapshotDate: date('snapshot_date').notNull(),
    rag: text('rag').notNull().default('no_data'),       // green | amber | red | no_data
    cpi: numeric('cpi', { precision: 10, scale: 4 }),
    spi: numeric('spi', { precision: 10, scale: 4 }),
    pctComplete: numeric('pct_complete', { precision: 5, scale: 2 }),
    bac: numeric('bac', { precision: 16, scale: 2 }).default('0'),
    ev: numeric('ev', { precision: 16, scale: 2 }).default('0'),
    ac: numeric('ac', { precision: 16, scale: 2 }).default('0'),
    eac: numeric('eac', { precision: 16, scale: 2 }).default('0'),
    margin: numeric('margin', { precision: 16, scale: 2 }).default('0'),
    wip: numeric('wip', { precision: 16, scale: 2 }).default('0'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byProject: index('idx_phs_project').on(t.projectId) }),
);

export type Project = typeof projects.$inferSelect;
export type ProjectChangeOrder = typeof projectChangeOrders.$inferSelect;
export type ProjectHealthSnapshot = typeof projectHealthSnapshots.$inferSelect;
export type ProjectBaseline = typeof projectBaselines.$inferSelect;
export type ProjectTemplate = typeof projectTemplates.$inferSelect;
export type ProjectTemplateItem = typeof projectTemplateItems.$inferSelect;
export type ProjectRisk = typeof projectRisks.$inferSelect;
export type ProjectTask = typeof projectTasks.$inferSelect;
export type ProjectMilestone = typeof projectMilestones.$inferSelect;
export type ResourceRate = typeof resourceRates.$inferSelect;
export type ProjectResource = typeof projectResources.$inferSelect;

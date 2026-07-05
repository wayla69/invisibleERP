import { pgTable, bigserial, bigint, text, numeric, integer, date, boolean, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// PROJ-03 — period-end project-close WIP/clearing review + sign-off. A preparer snapshots unbilled-WIP (GL
// 1260) + the applied-costs clearing balance (GL 2390) + the count of open projects under review and signs
// (Prepared); an independent approver (SoD: approver ≠ preparer) signs off (Approved). One row per (tenant,
// period). Detective control — the auditable record that WIP + clearing were reviewed at close.
export const projectCloseReviews = pgTable('project_close_reviews', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  period: text('period').notNull(), // YYYY-MM
  status: text('status').notNull().default('Prepared'), // Prepared | Approved | Rejected
  wipTotal: numeric('wip_total', { precision: 16, scale: 2 }).notNull().default('0'),            // GL 1260 net
  clearingBalance: numeric('clearing_balance', { precision: 16, scale: 2 }).notNull().default('0'), // GL 2390 net
  openProjects: integer('open_projects').notNull().default(0),
  preparedBy: text('prepared_by'),
  preparedAt: timestamp('prepared_at', { withTimezone: true }),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
}, (t) => ({ uq: unique('project_close_review_tenant_period_uq').on(t.tenantId, t.period) }));
export type ProjectCloseReview = typeof projectCloseReviews.$inferSelect;

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
    // FU1 (docs/32) — over-budget tolerance: a material draw may exceed a BoQ line by up to this % of the line
    // budget before it needs the over-budget approval (0 = strict, every overage needs sign-off).
    budgetTolerancePct: numeric('budget_tolerance_pct', { precision: 6, scale: 3 }).notNull().default('0'),
    contractAmount: numeric('contract_amount', { precision: 16, scale: 2 }).default('0'),
    status: text('status').notNull().default('Open'),         // Open | Active | Closed
    costToDate: numeric('cost_to_date', { precision: 16, scale: 2 }).default('0'),
    recognizedCost: numeric('recognized_cost', { precision: 16, scale: 2 }).default('0'),
    billedToDate: numeric('billed_to_date', { precision: 16, scale: 2 }).default('0'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    // Program (cross-project) scheduling (PMO-4): program_code groups projects into a program;
    // depends_on_projects is a CSV of project_codes this project must follow (finish-to-start) for the
    // program critical path. Operational/detective (rides PROJ-06) — non-posting.
    programCode: text('program_code'),
    dependsOnProjects: text('depends_on_projects'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_project_tenant').on(t.tenantId), byCrmOpp: index('idx_project_crm_opp').on(t.crmOppNo), byProgram: index('idx_project_program').on(t.programCode) }),
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

// Project material scope-change request (docs/32, PROJ-15). A requester (pr_raise) proposes adding a material
// item that is NOT on the project's approved BoQ; it parks 'pending' until an independent authoriser
// (planner/exec, ≠ requester) approves — on approval a new material line is appended to the approved BoQ (the
// budget grows) and the item becomes shoppable. A requester can only request budget, never expand it.
export const projectBoqChangeRequests = pgTable(
  'project_boq_change_requests',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id),
    boqId: bigint('boq_id', { mode: 'number' }).references(() => projectBoq.id),  // the BoQ the line is appended to
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    reqNo: text('req_no').notNull(),
    itemNo: text('item_no'),                                // → items.item_id (may be a new/free-text code)
    description: text('description'),
    uom: text('uom'),
    qty: numeric('qty', { precision: 18, scale: 4 }).notNull().default('0'),
    rate: numeric('rate', { precision: 16, scale: 2 }).notNull().default('0'),
    amount: numeric('amount', { precision: 16, scale: 2 }).notNull().default('0'), // = qty × rate (added budget)
    status: text('status').notNull().default('pending'),    // pending | approved | rejected
    newBoqLineId: bigint('new_boq_line_id', { mode: 'number' }).references(() => projectBoqLines.id), // created on approve
    requestedBy: text('requested_by'),
    approvedBy: text('approved_by'),                        // checker — must differ from requested_by (SoD)
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byProject: index('idx_bqr_project').on(t.projectId), byTenant: index('idx_bqr_tenant').on(t.tenantId, t.status) }),
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

// Bill of Quantities (BoQ) — M0, docs/32. The project's measured-works requirement & budget baseline for
// construction/contractor work. A BoQ header owns a set of rate-built lines (qty × rate = line budget); the
// sum of line budgets is the project's material/works budget. Maker-checker: a draft is authored, an
// independent approver (SoD: approver ≠ author) approves it — on approval the project's budget_amount is
// synced to the sum of lines (the enforceable baseline that M1's commitment ledger draws against). A locked
// BoQ is frozen (no further line edits); re-measurement records the actual measured qty vs the budget qty.
export const projectBoq = pgTable(
  'project_boq',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    boqNo: text('boq_no').notNull(),                          // business key (BOQ-YYYYMMDD-NNN)
    version: integer('version').notNull().default(1),
    title: text('title'),
    status: text('status').notNull().default('draft'),        // draft | approved | locked
    budgetTotal: numeric('budget_total', { precision: 16, scale: 2 }).notNull().default('0'), // Σ line budgets (snapshot on approve)
    approvedBy: text('approved_by'),                          // checker — must differ from created_by (SoD)
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byProject: index('idx_boq_project').on(t.projectId), byTenant: index('idx_boq_tenant').on(t.tenantId, t.projectId) }),
);

// A single BoQ line — a measured requirement (material/labor/subcon/other). budget_amount = budget_qty × rate.
// A material line optionally references the item master (item_no) so a requisition/PO can draw against it, and
// a WBS task (task_id/wbs_code) so schedule and cost reconcile. remeasured_qty is the actual measured qty (vs
// the budgeted qty) captured after works are done — the basis for re-measurement variance.
export const projectBoqLines = pgTable(
  'project_boq_lines',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    boqId: bigint('boq_id', { mode: 'number' }).notNull().references(() => projectBoq.id),
    projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id), // denormalized for line-scoped queries
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    lineNo: integer('line_no').notNull().default(0),
    category: text('category').notNull().default('material'), // material | labor | subcon | other
    itemNo: text('item_no'),                                   // → items.item_id (material lines; nullable)
    taskId: bigint('task_id', { mode: 'number' }),            // → project_tasks.id (nullable)
    wbsCode: text('wbs_code'),
    description: text('description'),
    uom: text('uom'),
    budgetQty: numeric('budget_qty', { precision: 18, scale: 4 }).notNull().default('0'),
    rate: numeric('rate', { precision: 16, scale: 2 }).notNull().default('0'),
    budgetAmount: numeric('budget_amount', { precision: 16, scale: 2 }).notNull().default('0'), // = budget_qty × rate
    remeasuredQty: numeric('remeasured_qty', { precision: 18, scale: 4 }),                       // actual measured qty (nullable)
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byBoq: index('idx_boq_line_boq').on(t.boqId), byProject: index('idx_boq_line_project').on(t.projectId), byTenant: index('idx_boq_line_tenant').on(t.tenantId, t.boqId) }),
);
export type ProjectBoq = typeof projectBoq.$inferSelect;
export type ProjectBoqLine = typeof projectBoqLines.$inferSelect;

// Commitment / encumbrance ledger (M1, docs/32, PROJ-12). Each row reserves part of a BoQ line's budget for a
// source document (a project PO today; a PMR/advance/reimbursement in later phases). `open` + `consumed`
// commitments both count against the line budget; `released` (e.g. a cancelled PO) frees it. The remaining a
// new draw may take is `line.budget_amount − Σ(open+consumed)` — checked atomically under a row-lock on the
// BoQ line so two concurrent draws cannot jointly overrun. This is what makes the material budget *enforced*
// rather than merely observed.
export const projectCommitments = pgTable(
  'project_commitments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id),
    boqLineId: bigint('boq_line_id', { mode: 'number' }).notNull().references(() => projectBoqLines.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    sourceDocType: text('source_doc_type').notNull(),        // PO | PMR | PR | ADV | REIMB
    sourceDocNo: text('source_doc_no').notNull(),
    qty: numeric('qty', { precision: 18, scale: 4 }).notNull().default('0'),
    amount: numeric('amount', { precision: 16, scale: 2 }).notNull().default('0'),
    status: text('status').notNull().default('open'),        // open | consumed | released
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byBoqLine: index('idx_commit_boq_line').on(t.boqLineId), byProject: index('idx_commit_project').on(t.projectId), bySource: index('idx_commit_source').on(t.sourceDocType, t.sourceDocNo), byTenant: index('idx_commit_tenant').on(t.tenantId, t.boqLineId) }),
);
export type ProjectCommitment = typeof projectCommitments.$inferSelect;

// Project Material Requisition (PMR) — M2, docs/32, PROJ-13. The single request document by which site staff
// draw material against a project's BoQ. On submit the system checks each line against its BoQ-line remaining
// budget: WITHIN budget → routed to procurement (a project-tagged PR is raised); OVER budget → parked
// `pending` and sent to an authoriser (maker-checker + a one-tap LINE approval card). On approval the
// over-budget draw is authorised and a project-tagged PO is auto-drafted (status Draft) for procurement to buy.
export const projectMaterialRequisitions = pgTable(
  'project_material_requisitions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: bigint('project_id', { mode: 'number' }).notNull().references(() => projects.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    pmrNo: text('pmr_no').notNull(),                          // PMR-YYYYMMDD-NNN
    status: text('status').notNull().default('pending'),      // routed | pending | approved | rejected
    route: text('route'),                                     // pr (within budget) | po (over budget → draft PO)
    overBudget: boolean('over_budget').notNull().default(false),
    estCost: numeric('est_cost', { precision: 16, scale: 2 }).notNull().default('0'), // total estimated cost
    overAmount: numeric('over_amount', { precision: 16, scale: 2 }).notNull().default('0'), // Σ per-line overage
    linkedDocNo: text('linked_doc_no'),                       // the raised PR / drafted PO number
    requestedBy: text('requested_by'),
    approvedBy: text('approved_by'),                          // checker — must differ from requested_by (SoD)
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byProject: index('idx_pmr_project').on(t.projectId), byTenant: index('idx_pmr_tenant').on(t.tenantId, t.status) }),
);

export const pmrLines = pgTable(
  'pmr_lines',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    pmrId: bigint('pmr_id', { mode: 'number' }).notNull().references(() => projectMaterialRequisitions.id),
    boqLineId: bigint('boq_line_id', { mode: 'number' }).notNull().references(() => projectBoqLines.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    itemNo: text('item_no'),
    qty: numeric('qty', { precision: 18, scale: 4 }).notNull().default('0'),
    unitCost: numeric('unit_cost', { precision: 16, scale: 2 }).notNull().default('0'),
    estCost: numeric('est_cost', { precision: 16, scale: 2 }).notNull().default('0'), // qty × unit_cost
    remaining: numeric('remaining', { precision: 16, scale: 2 }).notNull().default('0'), // BoQ-line remaining at submit
    overBudget: boolean('over_budget').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byPmr: index('idx_pmr_line_pmr').on(t.pmrId), byTenant: index('idx_pmr_line_tenant').on(t.tenantId, t.pmrId) }),
);
export type ProjectMaterialRequisition = typeof projectMaterialRequisitions.$inferSelect;
export type PmrLine = typeof pmrLines.$inferSelect;

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

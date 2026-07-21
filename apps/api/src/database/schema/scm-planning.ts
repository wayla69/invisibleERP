import {
  pgTable, bigserial, bigint, text, numeric, integer, boolean, date, timestamp, jsonb, index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// docs/54 — Dynamic Supply Chain & Demand Forecasting (migration 0459).
// Per-(branch,item) probabilistic demand planning + perishable-aware order optimization. The heavy
// maths runs in the external Python engine (services/forecast-engine); these tables hold the tenant
// data the API extracts under RLS, the results it persists, and the maker-checker plan lifecycle.
//
// Every table is tenant-scoped (0459 applies the canonical 0232-form org RLS loop + a leading
// (tenant_id, …) index). The unique indexes that carry `coalesce(branch_id, 0)` are created in the
// migration rather than here — drizzle-kit cannot express an expression index, and they are load
// bearing (they make the NULL-branch row unique and give the spike detector its per-day dedupe).

// One row per tenant (NULL tenant_id = the system default row) — receiving_settings shape.
export const scmSettings = pgTable('scm_settings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  horizonDays: integer('horizon_days').notNull().default(14),
  serviceLevel: numeric('service_level', { precision: 5, scale: 4 }).notNull().default('0.95'),
  samplePaths: integer('sample_paths').notNull().default(50),
  lookbackDays: integer('lookback_days').notNull().default(400),
  closedWeekdays: jsonb('closed_weekdays').notNull().default([]), // int[] 0=Sun..6=Sat, business TZ
  closures: jsonb('closures').notNull().default([]), // [{date, branch_id?, reason?}]
  // dine_in_orders has NO branch column — restaurant demand is attributed to this outlet. Unset ⇒ it
  // pools in the NULL-branch unit (reported as branch_null_share so the gap is visible, not silent).
  dineInBranchId: bigint('dine_in_branch_id', { mode: 'number' }),
  spikeEwmaAlpha: numeric('spike_ewma_alpha', { precision: 5, scale: 4 }).notNull().default('0.2'),
  spikeZThreshold: numeric('spike_z_threshold', { precision: 6, scale: 3 }).notNull().default('3'),
  spikeCusumK: numeric('spike_cusum_k', { precision: 6, scale: 3 }).notNull().default('0.5'),
  spikeCusumH: numeric('spike_cusum_h', { precision: 6, scale: 3 }).notNull().default('4'),
  spikeMinQty: numeric('spike_min_qty', { precision: 18, scale: 4 }).notNull().default('5'),
  spikeCooldownHours: integer('spike_cooldown_hours').notNull().default(48),
  autoReplan: boolean('auto_replan').notNull().default(false),
  engineEnabled: boolean('engine_enabled').notNull().default(true),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byTenant: index('idx_scm_settings_tenant').on(t.tenantId) }));

// Per-(branch,item) overrides; branchId NULL = the tenant-wide default for that item.
export const scmItemPolicies = pgTable('scm_item_policies', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  branchId: bigint('branch_id', { mode: 'number' }),
  itemId: text('item_id').notNull(),
  serviceLevel: numeric('service_level', { precision: 5, scale: 4 }),
  minOrderQty: numeric('min_order_qty', { precision: 14, scale: 3 }),
  orderMultiple: numeric('order_multiple', { precision: 14, scale: 3 }),
  maxStockQty: numeric('max_stock_qty', { precision: 18, scale: 4 }),
  leadTimeDays: numeric('lead_time_days', { precision: 8, scale: 2 }),
  shelfLifeDays: integer('shelf_life_days'), // tenant override of the shared items.shelf_life_days
  wasteCostPerUnit: numeric('waste_cost_per_unit', { precision: 18, scale: 4 }),
  stockoutCostPerUnit: numeric('stockout_cost_per_unit', { precision: 18, scale: 4 }),
  planningEnabled: boolean('planning_enabled').notNull().default(true),
  notes: text('notes'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byTenant: index('idx_scm_item_policies_tenant').on(t.tenantId, t.itemId) }));

// One row per planning run. uq_scm_nightly_run (partial, in 0459) is the DB-level nightly idempotency.
export const scmPlanRuns = pgTable('scm_plan_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  runNo: text('run_no').notNull(), // SCMR-YYYYMMDD-NNN
  runDate: date('run_date').notNull(),
  scope: text('scope').notNull().default('nightly'), // nightly | manual | replan
  triggerRef: text('trigger_ref'),
  engine: text('engine').notNull().default('fallback'), // external | fallback
  engineVersion: text('engine_version'),
  status: text('status').notNull().default('Running'), // Running | Completed | Failed
  branchCount: integer('branch_count'),
  itemCount: integer('item_count'),
  seriesCount: integer('series_count'),
  horizonDays: integer('horizon_days'),
  serviceLevel: numeric('service_level', { precision: 5, scale: 4 }),
  requestDigest: text('request_digest'), // sha256 of the extraction payload — audit / reproducibility
  metrics: jsonb('metrics').notNull().default({}),
  error: text('error'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => ({ byTenant: index('idx_scm_plan_runs_tenant').on(t.tenantId, t.runDate) }));

// Row per (run, branch, item) — see 0459 for why this is a table and not jsonb on the run.
export const scmDemandForecasts = pgTable('scm_demand_forecasts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  runId: bigint('run_id', { mode: 'number' }).notNull().references(() => scmPlanRuns.id),
  branchId: bigint('branch_id', { mode: 'number' }),
  itemId: text('item_id').notNull(),
  level: text('level').notNull().default('ingredient'), // ingredient | menu
  method: text('method').notNull(),
  horizon: integer('horizon').notNull(),
  startDate: date('start_date').notNull(),
  mean: jsonb('mean').notNull(), // number[horizon]
  p10: jsonb('p10'),
  p50: jsonb('p50'),
  p90: jsonb('p90'), // NULL for point-forecast fallbacks
  dataDays: integer('data_days'),
  wape: numeric('wape', { precision: 10, scale: 4 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byTenant: index('idx_scm_forecasts_tenant').on(t.tenantId, t.runId, t.branchId, t.itemId) }));

// Draft → PendingApproval → Approved → Converted (+ Rejected / Cancelled). approvedBy MUST differ
// from the maker — enforced in the service by assertMakerChecker (SCM-01), not by the schema.
export const scmOrderPlans = pgTable('scm_order_plans', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  planNo: text('plan_no').notNull(), // SCMP-YYYYMMDD-NNN
  runId: bigint('run_id', { mode: 'number' }).references(() => scmPlanRuns.id),
  branchId: bigint('branch_id', { mode: 'number' }),
  status: text('status').notNull().default('Draft'),
  horizonDays: integer('horizon_days'),
  serviceLevel: numeric('service_level', { precision: 5, scale: 4 }),
  estTotalCost: numeric('est_total_cost', { precision: 18, scale: 2 }).notNull().default('0'),
  expectedWasteCost: numeric('expected_waste_cost', { precision: 18, scale: 2 }),
  expectedStockoutCost: numeric('expected_stockout_cost', { precision: 18, scale: 2 }),
  expectedFillRate: numeric('expected_fill_rate', { precision: 6, scale: 4 }),
  engine: text('engine').notNull().default('fallback'),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  submittedBy: text('submitted_by'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
  prNo: text('pr_no'),
  convertedAt: timestamp('converted_at', { withTimezone: true }),
}, (t) => ({ byTenant: index('idx_scm_order_plans_tenant').on(t.tenantId, t.status) }));

export const scmOrderPlanLines = pgTable('scm_order_plan_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  planId: bigint('plan_id', { mode: 'number' }).notNull().references(() => scmOrderPlans.id),
  itemId: text('item_id').notNull(),
  itemDescription: text('item_description'),
  uom: text('uom'),
  suggestedQty: numeric('suggested_qty', { precision: 18, scale: 4 }).notNull(),
  finalQty: numeric('final_qty', { precision: 18, scale: 4 }).notNull(), // planner-editable while Draft
  unitCostEst: numeric('unit_cost_est', { precision: 18, scale: 4 }).notNull().default('0'),
  vendorId: bigint('vendor_id', { mode: 'number' }),
  onHandQty: numeric('on_hand_qty', { precision: 18, scale: 4 }),
  expiringQty: numeric('expiring_qty', { precision: 18, scale: 4 }),
  inTransitQty: numeric('in_transit_qty', { precision: 18, scale: 4 }),
  coverageDays: numeric('coverage_days', { precision: 8, scale: 2 }),
  stockoutRiskPct: numeric('stockout_risk_pct', { precision: 6, scale: 3 }),
  reason: text('reason').notNull().default('optimize'), // optimize | par_fallback | spike
  detail: jsonb('detail').notNull().default({}), // engine rationale, clamped flag, per-day order split
}, (t) => ({ byTenant: index('idx_scm_plan_lines_tenant').on(t.tenantId, t.planId) }));

// EWMA + CUSUM state for the spike detector. lastDay is the watermark that makes a scan at ANY
// cadence idempotent — it only folds in business days it has not already seen.
export const scmDemandBaselines = pgTable('scm_demand_baselines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  branchId: bigint('branch_id', { mode: 'number' }),
  itemId: text('item_id').notNull(),
  ewmaMean: numeric('ewma_mean', { precision: 18, scale: 6 }).notNull().default('0'),
  ewmaVar: numeric('ewma_var', { precision: 18, scale: 6 }).notNull().default('0'),
  cusumPos: numeric('cusum_pos', { precision: 18, scale: 6 }).notNull().default('0'),
  cusumNeg: numeric('cusum_neg', { precision: 18, scale: 6 }).notNull().default('0'),
  obsDays: integer('obs_days').notNull().default(0),
  lastDay: date('last_day'),
  lastSpikeAt: timestamp('last_spike_at', { withTimezone: true }), // cooldown anchor
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byTenant: index('idx_scm_baselines_tenant').on(t.tenantId, t.itemId) }));

// Audit + dedupe for detected spikes. uq_scm_spike_day (in 0459) is the hard per-day dedupe.
export const scmSpikeEvents = pgTable('scm_spike_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  branchId: bigint('branch_id', { mode: 'number' }),
  itemId: text('item_id').notNull(),
  day: date('day').notNull(),
  actualQty: numeric('actual_qty', { precision: 18, scale: 4 }).notNull(),
  expectedQty: numeric('expected_qty', { precision: 18, scale: 4 }).notNull(),
  zScore: numeric('z_score', { precision: 10, scale: 4 }),
  cusum: numeric('cusum', { precision: 10, scale: 4 }),
  direction: text('direction').notNull().default('up'), // up | down (down = over-stock warning)
  status: text('status').notNull().default('Open'), // Open | Replanned | Dismissed
  replanRunId: bigint('replan_run_id', { mode: 'number' }),
  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byTenant: index('idx_scm_spike_events_tenant').on(t.tenantId, t.status, t.detectedAt) }));

export type ScmSettingsRow = typeof scmSettings.$inferSelect;
export type ScmItemPolicy = typeof scmItemPolicies.$inferSelect;
export type ScmPlanRun = typeof scmPlanRuns.$inferSelect;
export type ScmDemandForecast = typeof scmDemandForecasts.$inferSelect;
export type ScmOrderPlan = typeof scmOrderPlans.$inferSelect;
export type ScmOrderPlanLine = typeof scmOrderPlanLines.$inferSelect;
export type ScmDemandBaseline = typeof scmDemandBaselines.$inferSelect;
export type ScmSpikeEvent = typeof scmSpikeEvents.$inferSelect;

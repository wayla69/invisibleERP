import { pgTable, bigserial, bigint, text, jsonb, timestamp, numeric, integer, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Marketing Intelligence push-back store (migration 0460, docs/48 phase 3).
// The standalone Python Marketing Intelligence Platform computes advanced MMM / Sentiment-Weighted RFM /
// TOWS in its own data warehouse and pushes the results back into the ERP over the public API
// (scope analytics:write). The ERP then OWNS the data it renders at /marketing-intel — no cross-database
// join (DB-isolation rule), and the page works even when the external platform is offline.
//
// One row per (tenant, kind); the writer upserts the LATEST snapshot per kind (unique index in 0460).
// Tenant-scoped: 0460 applies the canonical 0232-form org RLS loop + the leading (tenant_id, kind) index.
export const miAnalyticsSnapshots = pgTable('mi_analytics_snapshots', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  kind: text('kind').notNull(), // mmm | rfm | tows
  payload: jsonb('payload').notNull().default({}),
  modelRunRef: text('model_run_ref'),
  source: text('source').notNull().default('mi-platform'),
  pushedBy: text('pushed_by'),
  pushedAt: timestamp('pushed_at', { withTimezone: true }).defaultNow(),
  // Model Governance (docs/60 Phase 4, migration 0469). Back-compat: status DEFAULTS to 'Approved' so a
  // tenant without governance is unchanged; enabling mi_governance_settings.require_approval makes new
  // pushes land 'Pending' and gates activate/budget-plan on an Approved run.
  status: text('status').notNull().default('Approved'), // Pending | Approved | Rejected
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  modelCard: jsonb('model_card'),  // { model_version, training_window, features, metrics, … }
  quality: jsonb('quality'),        // { r2, prev_r2, r2_drop, drift, blocked, … } computed at push
}, (t) => ({
  byTenantKind: index('idx_mi_snapshots_tenant').on(t.tenantId, t.kind),
  byStatus: index('idx_mi_snapshots_status').on(t.tenantId, t.status, t.pushedAt),
}));

// Per-tenant governance toggle (docs/60 Phase 4). Absent ⇒ governance OFF (back-compat).
export const miGovernanceSettings = pgTable('mi_governance_settings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  requireApproval: boolean('require_approval').notNull().default(false),
  driftR2Drop: numeric('drift_r2_drop').notNull().default('0.15'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byTenant: uniqueIndex('ux_mi_governance_tenant').on(t.tenantId) }));

// Budget Optimizer plans (migration 0466, docs/60 Phase 1). A prescriptive MMM allocation the planner
// STAGES for approval — advisory only, never posts spend. Maker-checker: the approver (approved_by) must
// differ from the requester (requested_by), enforced in the service via assertMakerChecker (control MKT-17).
// Tenant-scoped: 0466 applies the canonical 0232-form org RLS loop + a leading (tenant_id, …) index.
export const miBudgetPlans = pgTable('mi_budget_plans', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  planNo: text('plan_no').notNull(),
  totalBudget: numeric('total_budget').notNull(),
  allocation: jsonb('allocation').notNull().default({}), // { channel: spend }
  predictedSales: numeric('predicted_sales'),
  basis: text('basis'), // the MMM model_run_ref the curves came from, or 'derived'
  status: text('status').notNull().default('Pending'), // Pending | Approved | Rejected
  note: text('note'),
  requestedBy: text('requested_by'),
  approvedBy: text('approved_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
}, (t) => ({ byTenant: index('idx_mi_budget_plans_tenant').on(t.tenantId, t.status, t.createdAt) }));

// Closed-loop measurement (docs/60 Phase 3, migration 0468). Activating a pushed mi_segment splits the
// eligible members ONCE into a treatment arm (contacted) and a randomised holdout control arm (NOT
// contacted), fixed at send time; after a window the lift on real POS revenue proves incrementality.
// Read/measurement model — no GL posting. Control MKT-19 (holdout integrity + read-only outcome).
export const miCampaignExperiments = pgTable('mi_campaign_experiments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  experimentNo: text('experiment_no').notNull(), // MIX-YYYYMMDD-NNN
  segment: text('segment').notNull(),
  campaignId: bigint('campaign_id', { mode: 'number' }),
  controlPct: numeric('control_pct').notNull().default('0.2'),
  windowDays: integer('window_days').notNull().default(14),
  treatmentCount: integer('treatment_count').notNull().default(0),
  controlCount: integer('control_count').notNull().default(0),
  status: text('status').notNull().default('Running'), // Running | Measured
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow(),
  measureAfter: timestamp('measure_after', { withTimezone: true }),
  treatmentRevenue: numeric('treatment_revenue'),
  controlRevenue: numeric('control_revenue'),
  treatmentPerHead: numeric('treatment_per_head'),
  controlPerHead: numeric('control_per_head'),
  incrementalRevenue: numeric('incremental_revenue'),
  liftPct: numeric('lift_pct'),
  measuredAt: timestamp('measured_at', { withTimezone: true }),
  measuredBy: text('measured_by'),
  createdBy: text('created_by'),
}, (t) => ({
  byTenant: index('idx_mi_experiments_tenant').on(t.tenantId, t.status, t.startedAt),
  byNo: uniqueIndex('ux_mi_experiments_no').on(t.tenantId, t.experimentNo),
}));

// Arm membership — one row per (experiment, member), FIXED at creation, never re-randomised. The control
// rows are the audit evidence those members were deliberately not contacted.
export const miExperimentArms = pgTable('mi_experiment_arms', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  experimentId: bigint('experiment_id', { mode: 'number' }).notNull().references(() => miCampaignExperiments.id),
  memberId: bigint('member_id', { mode: 'number' }).notNull(),
  arm: text('arm').notNull(), // treatment | control
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byMember: uniqueIndex('ux_mi_arms_member').on(t.tenantId, t.experimentId, t.memberId),
  byArm: index('idx_mi_arms_tenant').on(t.tenantId, t.experimentId, t.arm),
}));

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

// NBA Orchestrator (docs/61 Phase 3 / control MKT-22, migration 0471). Turns the advisory mi_nba into
// SEQUENCED, PRIORITISED action: a journey is STAGED (Pending) with its per-customer targets — each carrying
// the chosen action, its expected value (CLV × action uplift), and a FIXED holdout arm (treatment/control,
// same deterministic hash as MKT-19) — and requires MAKER-CHECKER activation by a DIFFERENT user before any
// consent-gated draft is created. Suppression (consent off / recent purchase) is enforced at STAGE time and
// recorded, so the control is auditable. Read/orchestration model — no GL posting.
export const miJourneys = pgTable('mi_journeys', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  journeyNo: text('journey_no').notNull(),                    // NBA-YYYYMMDD-NNN
  segment: text('segment'),                                   // the mi_segment scoped (null = all scored members)
  channel: text('channel').notNull().default('sms'),
  status: text('status').notNull().default('Pending'),        // Pending | Active | Cancelled
  controlPct: numeric('control_pct').notNull().default('0.2'),
  targetCount: integer('target_count').notNull().default(0),  // treatment targets (contactable)
  controlCount: integer('control_count').notNull().default(0),// holdout (never contacted)
  suppressedCount: integer('suppressed_count').notNull().default(0),
  campaignId: bigint('campaign_id', { mode: 'number' }),      // the consent-gated draft created at activation
  note: text('note'),
  requestedBy: text('requested_by'),
  approvedBy: text('approved_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  // Realized-outcome measurement (migration 0476, MKT-19 discipline extended to MKT-22): after the window,
  // treatment-vs-control REAL POS revenue via the CrmService read — the journey's measured proof of lift.
  measureAfter: timestamp('measure_after', { withTimezone: true }),   // activated_at + window_days
  treatmentRevenue: numeric('treatment_revenue', { precision: 16, scale: 2 }),
  controlRevenue: numeric('control_revenue', { precision: 16, scale: 2 }),
  treatmentPerHead: numeric('treatment_per_head', { precision: 16, scale: 2 }),
  controlPerHead: numeric('control_per_head', { precision: 16, scale: 2 }),
  realizedLiftPct: numeric('realized_lift_pct', { precision: 10, scale: 2 }), // null = control earned 0
  incrementalRevenue: numeric('incremental_revenue', { precision: 16, scale: 2 }),
  measuredAt: timestamp('measured_at', { withTimezone: true }),
  measuredBy: text('measured_by'),
}, (t) => ({
  byTenant: index('idx_mi_journeys_tenant').on(t.tenantId, t.status, t.createdAt),
  byNo: uniqueIndex('ux_mi_journeys_no').on(t.tenantId, t.journeyNo),
}));

// One row per (journey, member): the chosen next-best action, its expected value, the fixed holdout arm, and
// — for a suppressed member — why it was held back. Immutable once staged (the audit evidence of the plan).
export const miJourneyTargets = pgTable('mi_journey_targets', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  journeyId: bigint('journey_id', { mode: 'number' }).notNull().references(() => miJourneys.id),
  memberId: bigint('member_id', { mode: 'number' }).notNull(),
  action: text('action'),                                     // the mi_nba chosen (null when suppressed with no action)
  expectedValue: numeric('expected_value', { precision: 14, scale: 2 }),
  arm: text('arm').notNull().default('treatment'),            // treatment | control
  suppressed: boolean('suppressed').notNull().default(false),
  suppressReason: text('suppress_reason'),                    // CONSENT | RECENT_PURCHASE | NO_ACTION
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byMember: uniqueIndex('ux_mi_journey_targets_member').on(t.tenantId, t.journeyId, t.memberId),
  byArm: index('idx_mi_journey_targets_tenant').on(t.tenantId, t.journeyId, t.arm),
}));

// AI Campaign Studio (docs/61 Phase 4 / control MKT-21, migration 0472). Records every fact-grounded
// campaign GENERATION as ICFR/model-card evidence: the segment fact sheet it was grounded in, the prompt,
// the model used, and the produced draft — so an auditor can see exactly what facts + model produced a
// campaign and that the output was DRAFT-only (never auto-sent). The produced artifact is a consent-gated
// campaign DRAFT (loyalty_campaigns.status='draft'); the actual send stays the existing consent-gated,
// maker-checker campaign flow. Read/generation model — no GL posting.
export const miCampaignGenerations = pgTable('mi_campaign_generations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  genNo: text('gen_no').notNull(),                           // GEN-YYYYMMDD-NNN
  segment: text('segment'),
  channel: text('channel'),
  model: text('model').notNull().default('studio-template-v1'), // the model that produced the copy
  prompt: text('prompt'),                                    // the retrieval-grounded prompt (facts in, not hallucinated)
  facts: jsonb('facts'),                                     // the segment fact sheet the draft was grounded in
  draft: jsonb('draft'),                                     // the produced draft (audience, channel, hour, offer, th/en copy)
  campaignId: bigint('campaign_id', { mode: 'number' }),     // the consent-gated campaign DRAFT created (null = preview only)
  requestedBy: text('requested_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_mi_gen_tenant').on(t.tenantId, t.createdAt),
  byNo: uniqueIndex('ux_mi_gen_no').on(t.tenantId, t.genNo),
}));

// Churn-Save Autopilot (docs/61 Phase 5 / control MKT-24, migration 0473). Protect the base + PROVE the
// saved revenue. The save-offer POLICY (churn threshold, min CLV to justify a save, offer rate, and a hard
// OFFER CAP) is MAKER-CHECKER approved (a Pending policy must be approved by a DIFFERENT user before it is
// Active). A sweep applies the Active policy to at-risk customers, computes a CAPPED win-back offer, assigns
// a randomised HOLDOUT arm (MKT-19), and records a retention P&L (expected saved revenue vs offer cost).
// Read/orchestration model — no GL posting; the actual send stays the consent-gated, maker-checker flow.
export const miSavePolicies = pgTable('mi_save_policies', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  policyNo: text('policy_no').notNull(),                     // SAVEPOL-YYYYMMDD-NNN
  churnThreshold: numeric('churn_threshold', { precision: 5, scale: 4 }).notNull().default('0.5'), // [0,1]
  minClv: numeric('min_clv', { precision: 14, scale: 2 }).notNull().default('0'),
  offerRate: numeric('offer_rate', { precision: 6, scale: 4 }).notNull().default('0.1'),  // offer = clv × rate, capped
  offerCap: numeric('offer_cap', { precision: 14, scale: 2 }).notNull().default('500'),   // hard per-offer cap
  status: text('status').notNull().default('Pending'),      // Pending | Active | Superseded
  note: text('note'),
  requestedBy: text('requested_by'),
  approvedBy: text('approved_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
}, (t) => ({
  byTenant: index('idx_mi_save_pol_tenant').on(t.tenantId, t.status, t.createdAt),
  byNo: uniqueIndex('ux_mi_save_pol_no').on(t.tenantId, t.policyNo),
}));

// A staged save sweep: the retention P&L + the consent-gated draft it produced (treatment arm only).
export const miSaveRuns = pgTable('mi_save_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  runNo: text('run_no').notNull(),                          // SAVE-YYYYMMDD-NNN
  policyNo: text('policy_no'),                              // the Active policy applied
  segment: text('segment'),
  treatmentCount: integer('treatment_count').notNull().default(0),
  controlCount: integer('control_count').notNull().default(0),
  offerCost: numeric('offer_cost', { precision: 16, scale: 2 }),          // Σ capped offers (treatment)
  expectedSavedRevenue: numeric('expected_saved_revenue', { precision: 16, scale: 2 }),
  netBenefit: numeric('net_benefit', { precision: 16, scale: 2 }),        // saved − cost
  campaignId: bigint('campaign_id', { mode: 'number' }),
  requestedBy: text('requested_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  // Realized-outcome measurement (migration 0476, MKT-19 discipline extended to MKT-24): the run's
  // EXPECTED P&L above becomes a REALIZED retention P&L once treatment-vs-control POS revenue is measured.
  measureAfter: timestamp('measure_after', { withTimezone: true }),   // created_at + window_days
  treatmentRevenue: numeric('treatment_revenue', { precision: 16, scale: 2 }),
  controlRevenue: numeric('control_revenue', { precision: 16, scale: 2 }),
  treatmentPerHead: numeric('treatment_per_head', { precision: 16, scale: 2 }),
  controlPerHead: numeric('control_per_head', { precision: 16, scale: 2 }),
  realizedLiftPct: numeric('realized_lift_pct', { precision: 10, scale: 2 }),
  incrementalRevenue: numeric('incremental_revenue', { precision: 16, scale: 2 }), // realized saved revenue
  realizedNetBenefit: numeric('realized_net_benefit', { precision: 16, scale: 2 }), // incremental − offer_cost
  measuredAt: timestamp('measured_at', { withTimezone: true }),
  measuredBy: text('measured_by'),
}, (t) => ({
  byTenant: index('idx_mi_save_run_tenant').on(t.tenantId, t.createdAt),
  byNo: uniqueIndex('ux_mi_save_run_no').on(t.tenantId, t.runNo),
}));

// One row per (save run, member): the fixed holdout arm + the capped offer — persisted at stage time so a
// PAST run's treatment/control member lists are recoverable for realized measurement (the control arm is
// never contacted and exists nowhere else). Immutable once staged (the audit evidence of the sweep).
export const miSaveTargets = pgTable('mi_save_targets', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  runId: bigint('run_id', { mode: 'number' }).notNull().references(() => miSaveRuns.id),
  memberId: bigint('member_id', { mode: 'number' }).notNull(),
  arm: text('arm').notNull().default('treatment'),            // treatment | control
  offer: numeric('offer', { precision: 14, scale: 2 }),       // the capped offer (control: what it WOULD have been)
  expectedSaved: numeric('expected_saved', { precision: 14, scale: 2 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byMember: uniqueIndex('ux_mi_save_targets_member').on(t.tenantId, t.runId, t.memberId),
  byArm: index('idx_mi_save_targets_tenant').on(t.tenantId, t.runId, t.arm),
}));

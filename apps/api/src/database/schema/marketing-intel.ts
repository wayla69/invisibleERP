import { pgTable, bigserial, bigint, text, jsonb, timestamp, numeric, index } from 'drizzle-orm/pg-core';
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
}, (t) => ({ byTenantKind: index('idx_mi_snapshots_tenant').on(t.tenantId, t.kind) }));

// Budget Optimizer plans (migration 0462, docs/60 Phase 1). A prescriptive MMM allocation the planner
// STAGES for approval — advisory only, never posts spend. Maker-checker: the approver (approved_by) must
// differ from the requester (requested_by), enforced in the service via assertMakerChecker (control MKT-17).
// Tenant-scoped: 0462 applies the canonical 0232-form org RLS loop + a leading (tenant_id, …) index.
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

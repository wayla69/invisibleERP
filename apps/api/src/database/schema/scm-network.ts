import {
  pgTable, bigserial, bigint, text, numeric, integer, boolean, timestamp, index, jsonb,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// docs/57 Track B (B1) — multi-echelon supply-network master data (migration 0463).
//
// The tenant's supply topology as GOVERNED master data: a directed acyclic graph of stocking/flow
// nodes (supplier → DC / central-kitchen → branch) and the lanes (edges) between them. B1 owns only
// the definition + validation; the two-echelon optimizer (B2) consumes it via the scm-network module's
// public surface. Both tables are tenant-scoped — migration 0463 applies the canonical 0232-form org
// RLS loop + a leading (tenant_id, …) index. No other module writes them (no cross-writer NULL-tenant
// sweep). `branch_id` is an intra-tenant link to the existing `branches` (a company is one tenant).

// A stocking / flow node. `kind` ↔ `echelon`: supplier=0 (unbounded source), central_kitchen/dc=1
// (the pooling echelon), branch=2 (leaf; observed end-customer demand).
export const supplyNodes = pgTable('supply_nodes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  nodeCode: text('node_code').notNull(),            // tenant-unique business key
  name: text('name').notNull(),
  nameTh: text('name_th'),
  kind: text('kind').notNull(),                     // 'supplier' | 'central_kitchen' | 'dc' | 'branch'
  echelon: integer('echelon').notNull(),            // 0 supplier · 1 DC/kitchen · 2 branch
  branchId: bigint('branch_id', { mode: 'number' }),// → branches(id) when kind='branch' (intra-tenant)
  serviceTimeOutDays: numeric('service_time_out_days', { precision: 8, scale: 2 }).notNull().default('0'),
  holdingCostPerDay: numeric('holding_cost_per_day', { precision: 18, scale: 6 }).notNull().default('0'),
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byTenant: index('idx_supply_nodes_tenant').on(t.tenantId, t.nodeCode) }));

// A directed lane (edge) from an upstream node to a downstream node, carrying its own lead-time
// distribution and ordering constraints. A branch has exactly one inbound lane from its DC; a DC one
// from its supplier (multi-sourcing is out of scope — docs/57 §9).
export const supplyLanes = pgTable('supply_lanes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  fromNodeId: bigint('from_node_id', { mode: 'number' }).notNull(),
  toNodeId: bigint('to_node_id', { mode: 'number' }).notNull(),
  leadTimeMeanDays: numeric('lead_time_mean_days', { precision: 8, scale: 2 }).notNull().default('0'),
  leadTimeStdDays: numeric('lead_time_std_days', { precision: 8, scale: 2 }).notNull().default('0'),
  unitCost: numeric('unit_cost', { precision: 18, scale: 6 }).notNull().default('0'),
  moq: numeric('moq', { precision: 18, scale: 4 }).notNull().default('0'),
  packSize: numeric('pack_size', { precision: 18, scale: 4 }).notNull().default('1'),
  fixedOrderCost: numeric('fixed_order_cost', { precision: 18, scale: 6 }).notNull().default('0'),
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byTenant: index('idx_supply_lanes_tenant').on(t.tenantId, t.fromNodeId, t.toNodeId) }));

// docs/57 Track B (B2b) — a two-echelon network REPLENISHMENT PLAN for one item (migration 0471).
//
// Draft → PendingApproval → Approved → Converted (+ Rejected). Same maker-checker lifecycle as
// scm_order_plans: approvedBy MUST differ from the maker (the SUBMITTER, not created_by) — enforced in
// the service by assertMakerChecker (control SCM-05), never by the schema. A run persists the plan as
// Draft (never actionable); only an Approved plan may roll up to a purchase requisition, through the
// existing ProcurementService.createPr seam (idempotent by pr_no). The engine base-stock/order
// quantities are zod-validated + clamped before they land here.
export const scmNetworkPlans = pgTable('scm_network_plans', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  planNo: text('plan_no').notNull(),                 // SCMN-YYYYMMDD-NNN
  itemCode: text('item_code').notNull(),             // one item at a time across the whole network
  horizonDays: integer('horizon_days'),
  serviceLevel: numeric('service_level', { precision: 5, scale: 4 }),
  allocationMethod: text('allocation_method').notNull().default('proportional'),
  status: text('status').notNull().default('Draft'),
  engine: text('engine').notNull().default('fallback'),   // 'engine' (GSM) | 'fallback' (in-process)
  // Risk-pooling diagnostics reported by the run (docs/57 §1.3) — visible, never asserted.
  poolingBenefitPct: numeric('pooling_benefit_pct', { precision: 8, scale: 3 }),
  independentSafetyUnits: numeric('independent_safety_units', { precision: 18, scale: 4 }),
  pooledSafetyUnits: numeric('pooled_safety_units', { precision: 18, scale: 4 }),
  estTotalCost: numeric('est_total_cost', { precision: 18, scale: 2 }).notNull().default('0'),
  // Fair-share allocation lines emitted on a projected DC shortage (docs/57 §1.5; SCM-06 governs the
  // policy in B3). Stored on the header as jsonb — advisory diagnostics, not per-node rows.
  allocations: jsonb('allocations').notNull().default([]),
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
}, (t) => ({ byTenant: index('idx_scm_network_plans_tenant').on(t.tenantId, t.status) }));

// One row per STOCKING node (DC + branches; the supplier has no base-stock). Carries the GSM decision
// (service_time_out_days), the per-horizon-day base-stock vectors, the order schedule and the expected
// FEFO metrics — the auditable evidence a reviewer approves.
export const scmNetworkPlanLines = pgTable('scm_network_plan_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  planId: bigint('plan_id', { mode: 'number' }).notNull().references(() => scmNetworkPlans.id),
  nodeCode: text('node_code').notNull(),             // → supply_nodes.node_code (this tenant)
  echelon: integer('echelon').notNull(),             // 1 DC · 2 branch
  serviceTimeOutDays: numeric('service_time_out_days', { precision: 8, scale: 2 }).notNull().default('0'),
  baseStock: jsonb('base_stock').notNull().default([]),                 // per horizon day — echelon
  installationBaseStock: jsonb('installation_base_stock').notNull().default([]), // per day — installation
  safetyStock: jsonb('safety_stock').notNull().default([]),             // per horizon day
  orders: jsonb('orders').notNull().default([]),      // [{order_ds, arrival_ds, from_node, qty, packs}]
  expectedFillRate: numeric('expected_fill_rate', { precision: 6, scale: 4 }),
  expectedWasteCost: numeric('expected_waste_cost', { precision: 18, scale: 2 }),
  orderQty: numeric('order_qty', { precision: 18, scale: 4 }).notNull().default('0'), // Σ order qty (clamped)
  detail: jsonb('detail').notNull().default({}),      // engine rationale, clamped flag
}, (t) => ({ byTenant: index('idx_scm_network_plan_lines_tenant').on(t.tenantId, t.planId) }));

export type SupplyNodeRow = typeof supplyNodes.$inferSelect;
export type SupplyLaneRow = typeof supplyLanes.$inferSelect;
export type ScmNetworkPlanRow = typeof scmNetworkPlans.$inferSelect;
export type ScmNetworkPlanLineRow = typeof scmNetworkPlanLines.$inferSelect;

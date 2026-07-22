import {
  pgTable, bigserial, bigint, text, numeric, integer, boolean, timestamp, index,
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

export type SupplyNodeRow = typeof supplyNodes.$inferSelect;
export type SupplyLaneRow = typeof supplyLanes.$inferSelect;

// Phase 17A — Inventory costing (FIFO / Moving-Average / Standard) + valuation + ATP. Opt-in per
// (tenant, item) via item_costing: only configured items get cost layers + costed COGS GL. tenant_id
// REQUIRED → RLS. The costing engine turns stock into a real GL asset (1200) with method-correct COGS.
import { pgTable, bigserial, bigint, text, numeric, timestamp, date, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// per-tenant default (item_id NULL) + per-item override. method ∈ FIFO | AVG | STD
export const itemCosting = pgTable('item_costing', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  itemId: text('item_id'),
  method: text('method').notNull().default('AVG'),
  standardCost: numeric('standard_cost', { precision: 14, scale: 4 }),
  avgCost: numeric('avg_cost', { precision: 14, scale: 4 }).default('0'),  // running moving-avg (AVG)
  onHand: numeric('on_hand', { precision: 18, scale: 4 }).default('0'),     // AVG valuation qty mirror
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uq: unique('item_costing_uq').on(t.tenantId, t.itemId) }));

// FIFO receipt layers — consumed oldest-first. AVG/STD use one running cost (no layers).
export const costLayers = pgTable('cost_layers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  itemId: text('item_id').notNull(),
  grNo: text('gr_no'),
  receiptDate: date('receipt_date').notNull(),
  origQty: numeric('orig_qty', { precision: 18, scale: 4 }).notNull(),
  remainingQty: numeric('remaining_qty', { precision: 18, scale: 4 }).notNull(),
  unitCost: numeric('unit_cost', { precision: 14, scale: 4 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byItem: index('idx_layer_item').on(t.tenantId, t.itemId, t.receiptDate, t.id) }));

// append-only valuation audit — every receipt/issue with the method-computed cost (ties to GL)
export const costMovements = pgTable('cost_movements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  itemId: text('item_id').notNull(),
  moveDate: date('move_date').notNull(),
  kind: text('kind').notNull(),                     // RECEIPT | ISSUE | RETURN
  refDoc: text('ref_doc').notNull(),
  qty: numeric('qty', { precision: 18, scale: 4 }).notNull(),
  unitCost: numeric('unit_cost', { precision: 14, scale: 4 }).notNull(),
  extCost: numeric('ext_cost', { precision: 18, scale: 4 }).notNull(),
  method: text('method').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byRef: index('idx_costmv_ref').on(t.tenantId, t.refDoc), byItem: index('idx_costmv_item').on(t.tenantId, t.itemId, t.moveDate) }));

// ATP soft reservations — subtracted from on-hand. Released on fulfil/cancel.
export const stockAllocations = pgTable('stock_allocations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  itemId: text('item_id').notNull(),
  refDoc: text('ref_doc').notNull(),
  qty: numeric('qty', { precision: 18, scale: 4 }).notNull(),
  needBy: date('need_by'),
  status: text('status').notNull().default('Open'), // Open | Fulfilled | Cancelled
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byItem: index('idx_alloc_item').on(t.tenantId, t.itemId, t.status) }));

export type ItemCosting = typeof itemCosting.$inferSelect;
export type CostLayer = typeof costLayers.$inferSelect;

// Phase 17B — WMS (bins, putaway, pick/pack/ship, wave) + min-max replenishment + RMA. Posts ZERO GL —
// COGS is booked at sale-issue (17A); WMS only moves physical stock between bins. RMA reuses ReturnsService
// for the money. Every table is tenant-scoped (RLS via the 0002 loop). Reuses stock_movements/lot_ledger.
import { pgTable, bigserial, bigint, text, numeric, integer, date, timestamp, boolean, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { locations } from './inventory';

// bins — child of locations (warehouse → zone → aisle → bin)
export const bins = pgTable('bins', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  binCode: text('bin_code').notNull(),
  locationId: text('location_id').references(() => locations.locationId),
  aisle: text('aisle'), rack: text('rack'), level: text('level'),
  binType: text('bin_type').notNull().default('storage'), // storage | picking | quarantine | receiving | staging
  capacity: numeric('capacity'),
  // Storage-layout geometry (migration 0138) — bin position + size for the 2D floor plan / 3D warehouse view.
  // pos_x = aisle axis, pos_y = depth axis, pos_z = level/height; dim_* = footprint/height (display units).
  posX: numeric('pos_x', { precision: 10, scale: 2 }).notNull().default('0'),
  posY: numeric('pos_y', { precision: 10, scale: 2 }).notNull().default('0'),
  posZ: numeric('pos_z', { precision: 10, scale: 2 }).notNull().default('0'),
  dimW: numeric('dim_w', { precision: 10, scale: 2 }).notNull().default('1'),
  dimD: numeric('dim_d', { precision: 10, scale: 2 }).notNull().default('1'),
  dimH: numeric('dim_h', { precision: 10, scale: 2 }).notNull().default('1'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqBin: unique('bins_tenant_code_uq').on(t.tenantId, t.binCode) }));

// bin_stock — lowest-grain on-hand: item × bin × lot
export const binStock = pgTable('bin_stock', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  binId: bigint('bin_id', { mode: 'number' }).notNull().references(() => bins.id),
  itemId: text('item_id').notNull(),
  lotNo: text('lot_no').default(''),
  qty: numeric('qty').notNull().default('0'),
  uom: text('uom'),
  expiryDate: date('expiry_date'),
  lastUpdated: timestamp('last_updated', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqSlot: unique('bin_stock_slot_uq').on(t.tenantId, t.binId, t.itemId, t.lotNo), byItem: index('idx_binstock_item').on(t.tenantId, t.itemId) }));

export const pickWaves = pgTable('pick_waves', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  waveNo: text('wave_no').notNull().unique(),
  status: text('status').notNull().default('Open'), // Open | Picking | Picked | Packed | Shipped | Cancelled
  orderCount: integer('order_count').notNull().default(0),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const pickLists = pgTable('pick_lists', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  pickNo: text('pick_no').notNull().unique(),
  waveId: bigint('wave_id', { mode: 'number' }).references(() => pickWaves.id),
  sourceType: text('source_type').notNull(), // DINEIN | POS | SO
  sourceRef: text('source_ref').notNull(),
  status: text('status').notNull().default('Open'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqSource: unique('pick_source_uq').on(t.tenantId, t.sourceType, t.sourceRef) }));

export const pickListLines = pgTable('pick_list_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  pickId: bigint('pick_id', { mode: 'number' }).notNull().references(() => pickLists.id),
  itemId: text('item_id').notNull(),
  itemDescription: text('item_description'),
  requestedQty: numeric('requested_qty').notNull(),
  pickedQty: numeric('picked_qty').notNull().default('0'),
  binId: bigint('bin_id', { mode: 'number' }).references(() => bins.id),
  lotNo: text('lot_no'),
  uom: text('uom'),
  status: text('status').notNull().default('Open'), // Open | Picked | Short
});

export const shipments = pgTable('shipments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  shipmentNo: text('shipment_no').notNull().unique(),
  pickId: bigint('pick_id', { mode: 'number' }).references(() => pickLists.id),
  waveId: bigint('wave_id', { mode: 'number' }).references(() => pickWaves.id),
  sourceType: text('source_type'), sourceRef: text('source_ref'),
  carrier: text('carrier'), trackingNo: text('tracking_no'),
  status: text('status').notNull().default('Packed'), // Packed | Shipped | Delivered | Cancelled
  packedBy: text('packed_by'), packedAt: timestamp('packed_at', { withTimezone: true }),
  shippedBy: text('shipped_by'), shippedAt: timestamp('shipped_at', { withTimezone: true }),
});

export const replenishmentSuggestions = pgTable('replenishment_suggestions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  suggestionNo: text('suggestion_no').notNull().unique(),
  itemId: text('item_id').notNull(),
  onHand: numeric('on_hand').notNull(),
  reorderPoint: numeric('reorder_point').notNull(),
  suggestedQty: numeric('suggested_qty').notNull(), // = transferQty + buyQty (kept for back-compat)
  urgency: text('urgency'),
  status: text('status').notNull().default('Suggested'), // Suggested | PR_Created | Transfer_Done | Dismissed
  prNo: text('pr_no'),
  // Branch-aware transfer-before-buy routing (Phase). A low (branch,item) emits a 'transfer' row per source
  // branch + one 'buy' row for the residual. NULL on legacy/tenant-wide rows (back-compat).
  branchId: bigint('branch_id', { mode: 'number' }),       // the branch that is short
  route: text('route'),                                     // 'transfer' | 'buy'
  fromBranchId: bigint('from_branch_id', { mode: 'number' }), // source branch (transfer leg only)
  transferQty: numeric('transfer_qty'),
  buyQty: numeric('buy_qty'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byItemStatus: index('idx_rpl_item').on(t.tenantId, t.itemId, t.status) }));

export const rmas = pgTable('rmas', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  rmaNo: text('rma_no').notNull().unique(),
  saleNo: text('sale_no'),
  customerRef: text('customer_ref'),
  status: text('status').notNull().default('Requested'), // Requested | Authorized | Received | Inspected | Restocked | Credited | Rejected
  reason: text('reason'),
  returnNo: text('return_no'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
export const rmaLines = pgTable('rma_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  rmaId: bigint('rma_id', { mode: 'number' }).notNull().references(() => rmas.id),
  saleItemId: bigint('sale_item_id', { mode: 'number' }),
  itemId: text('item_id').notNull(),
  qty: numeric('qty').notNull(),
  lotNo: text('lot_no'),
  uom: text('uom'),
  disposition: text('disposition').notNull().default('restock'), // restock | quarantine | scrap
  restockBinId: bigint('restock_bin_id', { mode: 'number' }).references(() => bins.id),
});

export type Bin = typeof bins.$inferSelect;
export type PickList = typeof pickLists.$inferSelect;

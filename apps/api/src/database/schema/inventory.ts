import { pgTable, bigserial, bigint, text, numeric, integer, date, timestamp, boolean, index, unique } from 'drizzle-orm/pg-core';
import { moveTypeEnum, lotStatusEnum, stocktakeStatusEnum } from './enums';
import { tenants } from './tenants';

// Item master — เดิม tbl_raw_inventory เป็นทั้ง master + stock fact; V2 แยกออกมา (master จริงเดิมอยู่ใน CSV)
export const items = pgTable('items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  itemId: text('item_id').notNull().unique(),
  itemDescription: text('item_description'),
  barcode: text('barcode'),                                     // GTIN/EAN/UPC for hardware scan-to-add (exact match)
  supplyType: text('supply_type').notNull().default('goods'),   // 'goods' | 'service' — VAT tax-point class (5.1, ม.78 vs 78/1). Inert until 5.1b.
  uom: text('uom'),
  baseUom: text('base_uom'),
  conversionFactor: numeric('conversion_factor').default('1'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).default('0'),
  category: text('category'),
  temperatureType: text('temperature_type'),
  buId: text('bu_id'),
  minStock: numeric('min_stock').default('0'),
  maxStock: numeric('max_stock').default('9999'),
  avgDailyUsage: numeric('avg_daily_usage').default('0'),
  leadTimeDays: numeric('lead_time_days').default('3'),
  // Lot-sizing / EOQ inputs (Phase D3) — used by MRP planned-buy lot-sizing.
  minOrderQty: numeric('min_order_qty', { precision: 14, scale: 3 }).default('0'),
  orderMultiple: numeric('order_multiple', { precision: 14, scale: 3 }).default('0'),
  orderCost: numeric('order_cost', { precision: 14, scale: 2 }).default('0'),   // S: per-PO cost
  holdingCost: numeric('holding_cost', { precision: 14, scale: 4 }).default('0'), // H: per unit/yr
  imageKey: text('image_key'),
  // Capital goods (FA-10): items flagged as fixed assets are routed to the asset register on receipt
  // (Dr 1500) rather than capitalised into inventory (Dr 1200). default_asset_category_id seeds the
  // depreciation category when the GR line is registered.
  isFixedAsset: boolean('is_fixed_asset').notNull().default(false),
  defaultAssetCategoryId: bigint('default_asset_category_id', { mode: 'number' }),
  // Item-posting setup (docs/33, GL-21). Global-default account/tax profile — accounts are a global
  // canonical universe so an item-level default is tenant-neutral; a tenant overrides per-category
  // (item_categories) or via posting_rules. All nullable → fall through to category → warehouse → global
  // posting-rule default (resolution wired in PR2). categoryId supersedes the free-text `category` above.
  categoryId: bigint('category_id', { mode: 'number' }),
  revenueAccount: text('revenue_account'),
  cogsAccount: text('cogs_account'),
  inventoryAccount: text('inventory_account'),
  valuationAccount: text('valuation_account'),
  vatCode: text('vat_code'),
  whtIncomeType: text('wht_income_type'),
  defaultLocationId: text('default_location_id'),
  // Item lifecycle (master-data audit Phase 10) — active | inactive | discontinued. A discontinued item may
  // point at its replacement via superseded_by (→ items.id). `items` is a SHARED master (no tenant_id) so
  // these columns need NO RLS loop (see CLAUDE.md — new item columns are tenant-neutral).
  status: text('status').notNull().default('active'),
  supersededBy: bigint('superseded_by', { mode: 'number' }),
  // Match-merge / DQM (master-data audit Phase 11) — a duplicate item soft-retired into a survivor keeps its
  // row (status='merged') with a pointer back to the survivor + who/when, so the merge stays traceable.
  mergedInto: bigint('merged_into', { mode: 'number' }),
  mergedBy: text('merged_by'),
  mergedAt: timestamp('merged_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Stock fact — append-only snapshots (tbl_raw_inventory, 1.48M rows). current = latest generate_date.
// Phase 1.5: แปลงเป็น PARTITION BY RANGE(generate_date) ผ่าน custom SQL.
export const stockSnapshots = pgTable(
  'stock_snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    generateDate: timestamp('generate_date', { withTimezone: true }).notNull(),
    itemId: text('item_id').notNull(),
    itemDescription: text('item_description'),
    uom: text('uom'),
    temperatureType: text('temperature_type'),
    buId: text('bu_id'),
    expiryDate: date('expiry_date'), // เดิม "Expired Date" (เว้นวรรค)
    avQty: numeric('av_qty'),
    deliveryQty: integer('delivery_qty'),
    totalStock: numeric('total_stock'),
  },
  (t) => ({ byItemDate: index('idx_snap_item_date').on(t.itemId, t.generateDate) }),
);

export const locations = pgTable('locations', {
  locationId: text('location_id').primaryKey(),
  locationName: text('location_name'),
  zone: text('zone').default('Main'),
  type: text('type').default('Storage'),
  capacity: numeric('capacity'),
  temperature: text('temperature').default('Ambient'),
  active: boolean('active').default(true),
  notes: text('notes'),
  // Warehouse account defaults (docs/33 PR5, GL-21). The lowest tier of item-posting determination:
  // an item's inventory/adjustment account falls through item → its category → THIS warehouse → the control
  // literal (1200/5810). Nullable ⇒ no effect unless set + the tenant opts into posting_determination.
  inventoryAccount: text('inventory_account'),
  adjustmentAccount: text('adjustment_account'),
});

export const locationStock = pgTable('location_stock', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  locationId: text('location_id').references(() => locations.locationId),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  lotNo: text('lot_no'),
  qty: numeric('qty'),
  uom: text('uom'),
  expiryDate: date('expiry_date'),
  lastUpdated: timestamp('last_updated', { withTimezone: true }),
}, (t) => ({
  byItemLoc: index('idx_locstock_item').on(t.itemId, t.locationId),
}));

export const lotLedger = pgTable('lot_ledger', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  lotNo: text('lot_no'),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  uom: text('uom'),
  locationId: text('location_id').default('WH-MAIN'),
  grNo: text('gr_no'),
  qtyIn: numeric('qty_in'),
  qtyOut: numeric('qty_out'),
  balance: numeric('balance'),
  mfgDate: date('mfg_date'),
  expiryDate: date('expiry_date'),
  status: lotStatusEnum('status').default('Active'),
  moveDate: timestamp('move_date', { withTimezone: true }),
  refDoc: text('ref_doc'),
  createdBy: text('created_by'),
}, (t) => ({
  byItemLoc: index('idx_ll_item_loc').on(t.itemId, t.locationId),
  byLot: index('idx_ll_lot').on(t.lotNo),
}));

export const stockMovements = pgTable('stock_movements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // 0299 (see stocktakes)
  moveDate: timestamp('move_date', { withTimezone: true }),
  docNo: text('doc_no'),
  moveType: moveTypeEnum('move_type'),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  uom: text('uom'),
  qty: numeric('qty'),
  fromLocation: text('from_location'),
  toLocation: text('to_location'),
  refDoc: text('ref_doc'),
  remarks: text('remarks'),
  createdBy: text('created_by'),
}, (t) => ({
  byItemDate: index('idx_sm_item_date').on(t.itemId, t.moveDate),
  byDoc: index('idx_sm_doc').on(t.docNo),
}));

export const stocktakes = pgTable('stocktakes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  // 0299: added — the table used to have NO tenant column, so the RLS loop skipped it and every read
  // (list/detail) and the variance POST were global across tenants. Legacy rows keep NULL (unattributable).
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  stNo: text('st_no'),
  stDate: date('st_date'),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  uom: text('uom'),
  systemQty: numeric('system_qty'),
  physicalQty: numeric('physical_qty'),
  difference: numeric('difference'),
  countedBy: text('counted_by'),
  postedBy: text('posted_by'),                                                   // 0300 — SoD R11 evidence: the independent poster
  postedAt: timestamp('posted_at', { withTimezone: true }),
  status: stocktakeStatusEnum('status').default('Draft'),
  remarks: text('remarks'),
});

// ── Perpetual inventory valuation sub-ledger (0130) ──────────────────────────────────────────
// inv_moves: append-only VALUED movement ledger; inv_balances: running moving-average position.
// Both are tenant-scoped (RLS). Every financial move posts a balanced JE via LedgerService so the
// inventory control account (1200) ties to inv_balances.total_value (reconcile).
export const invMoves = pgTable('inv_moves', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }),
  moveNo: text('move_no').notNull(),
  moveDate: timestamp('move_date', { withTimezone: true }).defaultNow(),
  moveType: text('move_type').notNull(), // 'receipt' | 'issue' | 'adjust'
  itemId: text('item_id').notNull(),
  itemDescription: text('item_description'),
  uom: text('uom'),
  locationId: text('location_id').default('WH-MAIN'),
  qty: numeric('qty', { precision: 18, scale: 4 }).notNull(),        // signed: + in / − out
  unitCost: numeric('unit_cost', { precision: 18, scale: 4 }).notNull().default('0'),
  totalCost: numeric('total_cost', { precision: 18, scale: 4 }).notNull().default('0'),
  balanceQty: numeric('balance_qty', { precision: 18, scale: 4 }),   // on-hand after this move
  avgCost: numeric('avg_cost', { precision: 18, scale: 4 }),         // moving-average after this move
  refType: text('ref_type'),
  refId: text('ref_id'),
  reason: text('reason'),
  glEntryNo: text('gl_entry_no'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byItem: index('idx_inv_moves_item').on(t.tenantId, t.itemId, t.locationId),
  byNo: index('idx_inv_moves_no').on(t.tenantId, t.moveNo),
}));

export const invBalances = pgTable('inv_balances', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }),
  itemId: text('item_id').notNull(),
  itemDescription: text('item_description'),
  locationId: text('location_id').notNull().default('WH-MAIN'),
  onHandQty: numeric('on_hand_qty', { precision: 18, scale: 4 }).notNull().default('0'),
  avgCost: numeric('avg_cost', { precision: 18, scale: 4 }).notNull().default('0'),
  totalValue: numeric('total_value', { precision: 18, scale: 4 }).notNull().default('0'),
  costingMethod: text('costing_method').notNull().default('moving_avg'), // 'moving_avg' | 'fifo' | 'fefo' (0131)
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byItem: index('idx_inv_balances_item').on(t.tenantId, t.itemId),
}));

// Inventory write-off maker-checker (INV-07, 0136) — a stock write-off (negative adjustment) is a REQUEST
// that posts nothing until a DIFFERENT user approves; on approval the real valued adjustment runs.
export const invWriteoffRequests = pgTable('inv_writeoff_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }),
  itemId: text('item_id').notNull(),
  locationId: text('location_id').notNull().default('WH-MAIN'),
  qtyDelta: numeric('qty_delta', { precision: 18, scale: 4 }).notNull(),     // negative (a write-off)
  estValue: numeric('est_value', { precision: 18, scale: 4 }).notNull().default('0'),
  reason: text('reason').notNull(),
  status: text('status').notNull().default('PendingApproval'),               // PendingApproval | Posted | Rejected
  requestedBy: text('requested_by'),
  approvedBy: text('approved_by'),                                           // checker — must differ from requestedBy
  moveNo: text('move_no'),
  glEntryNo: text('gl_entry_no'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
}, (t) => ({
  byStatus: index('idx_inv_writeoff_status').on(t.tenantId, t.status),
}));

// FIFO/FEFO cost layers (0131) — one row per valued receipt of a fifo/fefo item; issues + shrinkage
// consume layers in order (FEFO = soonest expiry first, FIFO = oldest receipt first) at actual layer cost.
export const invCostLayers = pgTable('inv_cost_layers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }),
  itemId: text('item_id').notNull(),
  locationId: text('location_id').notNull().default('WH-MAIN'),
  lotNo: text('lot_no'),
  expiryDate: date('expiry_date'),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow(),
  origQty: numeric('orig_qty', { precision: 18, scale: 4 }).notNull(),
  remainingQty: numeric('remaining_qty', { precision: 18, scale: 4 }).notNull(),
  unitCost: numeric('unit_cost', { precision: 18, scale: 4 }).notNull().default('0'),
  refType: text('ref_type'),
  refId: text('ref_id'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byConsume: index('idx_inv_layers_consume').on(t.tenantId, t.itemId, t.locationId, t.remainingQty),
  byFefo: index('idx_inv_layers_fefo').on(t.tenantId, t.itemId, t.locationId, t.expiryDate),
}));

// Stock reservation (M3, docs/32, INV-13) — a soft allocation of on-hand stock to a project. Reserving holds
// qty against an item+location so available-to-issue = on_hand − Σ(held). A reservation is `held`, then either
// `released` (freed) or `consumed` (issued to the project → the value moves from inventory 1200 to project WIP
// 1260). Prevents double-allocation of the same stock to two projects.
export const stockReservations = pgTable('stock_reservations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }),
  itemId: text('item_id').notNull(),
  locationId: text('location_id').notNull().default('WH-MAIN'),
  projectId: bigint('project_id', { mode: 'number' }).notNull(),
  boqLineId: bigint('boq_line_id', { mode: 'number' }),
  sourceDocType: text('source_doc_type').notNull().default('RES'), // RES | PMR
  sourceDocNo: text('source_doc_no'),
  qtyReserved: numeric('qty_reserved', { precision: 18, scale: 4 }).notNull().default('0'),
  status: text('status').notNull().default('held'),                 // held | released | consumed
  issueNo: text('issue_no'),                                        // the INV move / JE that consumed it
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byItemLoc: index('idx_stock_res_item').on(t.tenantId, t.itemId, t.locationId),
  byProject: index('idx_stock_res_project').on(t.projectId),
}));
export type StockReservation = typeof stockReservations.$inferSelect;

export const scanSessions = pgTable('scan_sessions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sessionNo: text('session_no').unique(),
  sessionType: text('session_type'),
  locationId: text('location_id'),
  docRef: text('doc_ref'),
  status: text('status').default('Open'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const scanLines = pgTable('scan_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sessionNo: text('session_no'),
  scannedAt: timestamp('scanned_at', { withTimezone: true }),
  qrData: text('qr_data'),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  lotNo: text('lot_no'),
  expiryDate: date('expiry_date'),
  qty: numeric('qty').default('1'),
  uom: text('uom'),
  action: text('action'),
  locationId: text('location_id'),
  confirmed: boolean('confirmed').default(false),
  clientUuid: text('client_uuid'), // offline idempotency — unique per (session_no, client_uuid) in 0251
});

// Per-tenant preferred-supplier link for an item (Phase — branch-aware replenishment "buy" leg).
// Lets the auto-PR/PO know WHICH vendor to order from + at what price. vendor_id → vendors(id) (FK in the
// migration; kept a plain bigint here to avoid a schema import cycle). Tenant-scoped → RLS via the 0002 loop.
export const itemSupplier = pgTable('item_supplier', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  itemId: text('item_id'),
  vendorId: bigint('vendor_id', { mode: 'number' }), // vendors.id
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
  leadTimeDays: integer('lead_time_days').default(3),
  preferred: boolean('preferred').default(false),
}, (t) => ({
  uq: unique('item_supplier_uq').on(t.tenantId, t.itemId, t.vendorId),
  byItem: index('idx_itemsupplier_item').on(t.tenantId, t.itemId),
}));

export type Item = typeof items.$inferSelect;
export type StockSnapshot = typeof stockSnapshots.$inferSelect;

import { pgTable, bigserial, bigint, text, numeric, integer, date, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { moveTypeEnum, lotStatusEnum, stocktakeStatusEnum } from './enums';

// Item master — เดิม tbl_raw_inventory เป็นทั้ง master + stock fact; V2 แยกออกมา (master จริงเดิมอยู่ใน CSV)
export const items = pgTable('items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  itemId: text('item_id').notNull().unique(),
  itemDescription: text('item_description'),
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
  stNo: text('st_no'),
  stDate: date('st_date'),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  uom: text('uom'),
  systemQty: numeric('system_qty'),
  physicalQty: numeric('physical_qty'),
  difference: numeric('difference'),
  countedBy: text('counted_by'),
  status: stocktakeStatusEnum('status').default('Draft'),
  remarks: text('remarks'),
});

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
});

export type Item = typeof items.$inferSelect;
export type StockSnapshot = typeof stockSnapshots.$inferSelect;

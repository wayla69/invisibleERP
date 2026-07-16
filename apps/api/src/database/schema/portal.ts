import { pgTable, bigserial, bigint, text, numeric, timestamp, boolean, integer, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const customerItems = pgTable('customer_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  itemId: text('item_id'),
  itemName: text('item_name'),
  category: text('category'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
  uom: text('uom'),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }),
  syncedCentral: boolean('synced_central').default(true),
});

export const customerInventory = pgTable('customer_inventory', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  uom: text('uom'),
  currentStock: numeric('current_stock'),
  reorderPoint: numeric('reorder_point'),
  reorderQty: numeric('reorder_qty'),
  lastUpdated: timestamp('last_updated', { withTimezone: true }),
  notes: text('notes'),
});

export const custStockLog = pgTable('cust_stock_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  branchId: bigint('branch_id', { mode: 'number' }), // multi-branch — outlet whose stock moved (NULL = untagged/HQ)
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  logDate: timestamp('log_date', { withTimezone: true }),
  logType: text('log_type'),
  qtyChange: numeric('qty_change'),
  balanceAfter: numeric('balance_after'),
  refDoc: text('ref_doc'),
  notes: text('notes'),
  createdBy: text('created_by'),
});

// ── Waste / spoilage log (W1) ──
// Reason-coded ingredient waste: decrements customer_inventory + (when costed) posts Dr 5810 Scrap/Waste
// Loss / Cr 1200 Inventory (mirrors recipe COGS, which credits 1200 on consumption). The food-cost lever —
// what was wasted, why, how much it cost. Distinct from the INV-07 maker-checker write-off (perpetual items).
export const wasteLog = pgTable('waste_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  branchId: bigint('branch_id', { mode: 'number' }),
  wasteNo: text('waste_no').notNull(),                 // WASTE-YYYYMMDD-NNN
  itemId: text('item_id').notNull(),
  itemDescription: text('item_description'),
  qty: numeric('qty', { precision: 18, scale: 4 }).notNull(),
  uom: text('uom'),
  reasonCode: text('reason_code').notNull(),           // damage | expiry | spoilage | overproduction | prep_error | void_fire | other
  disposition: text('disposition'),                     // POS-5a — WHAT happened to it: discard | compost | donate | staff_meal | rework | return_supplier
  source: text('source'),                               // POS-5a — HOW captured: manual | void_fire | spoilage
  refDoc: text('ref_doc'),                               // POS-5a — originating doc (e.g. the voided ticket/sale no)
  unitCost: numeric('unit_cost', { precision: 18, scale: 4 }).notNull().default('0'),
  totalCost: numeric('total_cost', { precision: 18, scale: 4 }).notNull().default('0'),
  notes: text('notes'),
  journalNo: text('journal_no'),                        // JE-... when the waste was costed to GL
  // A5 (docs/50 Wave 5) — optional project dimension: a project-tagged, costed waste relieves PROJECT WIP
  // (Cr 1260, project_id line dimension) instead of inventory (Cr 1200) and feeds the per-BoQ-line "wasted"
  // figure in the material control tower. NULL = ordinary kitchen/warehouse waste, byte-identical to before.
  projectId: bigint('project_id', { mode: 'number' }),
  boqLineId: bigint('boq_line_id', { mode: 'number' }),
  loggedBy: text('logged_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byPeriod: index('idx_waste_log_period').on(t.tenantId, t.reasonCode),
  byDisposition: index('idx_waste_log_disposition').on(t.tenantId, t.disposition),
  byProject: index('idx_waste_log_project').on(t.tenantId, t.projectId),
}));

// Per-branch on-hand ledger (Phase — branch-aware replenishment). Runs ALONGSIDE customer_inventory:
// customer_inventory stays the tenant rollup (13 readers untouched); branch_stock is the per-branch detail
// the transfer-before-buy router consumes. Invariant: customer_inventory.current_stock == Σ branch_stock.on_hand
// per (tenant,item) + untagged_remainder (legacy/HQ stock not yet branch-attributed). RLS via the 0002 loop.
export const branchStock = pgTable('branch_stock', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  branchId: bigint('branch_id', { mode: 'number' }), // outlet that holds this stock (branches.id)
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  uom: text('uom'),
  onHand: numeric('on_hand').default('0'),
  reorderPoint: numeric('reorder_point').default('0'),
  reorderQty: numeric('reorder_qty').default('0'),
  // Step 5 — supplier lead time for this (branch,item); feeds the demand-driven reorder-point recommendation
  // (avg daily usage × lead_time_days × safety factor).
  leadTimeDays: integer('lead_time_days').notNull().default(3),
  lastUpdated: timestamp('last_updated', { withTimezone: true }),
}, (t) => ({
  uq: unique('branch_stock_uq').on(t.tenantId, t.branchId, t.itemId),
  byItem: index('idx_branchstock_item').on(t.tenantId, t.itemId),
}));

// Mini-ERP (เดิม Owner_Customer → tenant_id)
export const myCustomers = pgTable('my_customers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  customerName: text('customer_name'),
  phone: text('phone'),
  address: text('address'),
  notes: text('notes'),
});

export const mySuppliers = pgTable('my_suppliers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  supplierName: text('supplier_name'),
  contactName: text('contact_name'),
  phone: text('phone'),
  address: text('address'),
});

export const myPurchaseOrders = pgTable('my_purchase_orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  poNo: text('po_no').notNull().unique(), // MPO-
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  poDate: text('po_date'),
  supplierName: text('supplier_name'),
  totalAmount: numeric('total_amount', { precision: 14, scale: 2 }),
  status: text('status').default('Issued'),
  remarks: text('remarks'),
});

export const myPoItems = pgTable('my_po_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  myPoId: bigint('my_po_id', { mode: 'number' }).references(() => myPurchaseOrders.id),
  itemDescription: text('item_description'), // ไม่มี item_id (free text)
  qty: numeric('qty'),
  uom: text('uom'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
  amount: numeric('amount', { precision: 14, scale: 2 }),
});

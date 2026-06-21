import { pgTable, bigserial, bigint, text, numeric, timestamp, boolean } from 'drizzle-orm/pg-core';
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

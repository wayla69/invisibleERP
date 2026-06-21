import { pgTable, bigserial, bigint, text, numeric, integer, date, timestamp, boolean } from 'drizzle-orm/pg-core';
import { poStatusEnum } from './enums';

// รวม tbl_suppliers + tbl_creditors (overlapping vendor masters)
export const vendors = pgTable('vendors', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  vendorCode: text('vendor_code').unique(),
  name: text('name').notNull(),
  isSupplier: boolean('is_supplier').default(true),
  isCreditor: boolean('is_creditor').default(false),
  contact: text('contact'),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  taxId: text('tax_id'),
  paymentTerms: text('payment_terms').default('Cash'),
  leadTimeDays: integer('lead_time_days').default(3),
  rating: numeric('rating').default('3.0'),
  bankName: text('bank_name'),
  bankAccount: text('bank_account'),
  creditLimit: numeric('credit_limit', { precision: 14, scale: 2 }),
  currency: text('currency').default('THB'),
  category: text('category').default('Supplier'),
  active: boolean('active').default(true),
  notes: text('notes'),
});

export const supplierRequests = pgTable('supplier_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  reqDate: date('req_date'),
  supplierName: text('supplier_name'),
  contact: text('contact'),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  paymentTerms: text('payment_terms'),
  leadTimeDays: integer('lead_time_days'),
  requestedBy: text('requested_by'),
  status: text('status').default('Pending'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  remarks: text('remarks'),
});

export const purchaseRequests = pgTable('purchase_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  prNo: text('pr_no').notNull().unique(),
  prDate: date('pr_date'),
  requestedBy: text('requested_by'),
  status: text('status').default('Draft'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  remarks: text('remarks'),
  priority: text('priority').default('Normal'),
});

export const prItems = pgTable('pr_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  prId: bigint('pr_id', { mode: 'number' }).references(() => purchaseRequests.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  requestQty: numeric('request_qty'),
  uom: text('uom'),
  requiredDate: date('required_date'),
  reason: text('reason'),
  poNo: text('po_no'),
  status: text('status').default('Open'),
});

export const purchaseOrders = pgTable('purchase_orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  poNo: text('po_no').notNull().unique(), // PO-YYYYMMDD-NNN
  poDate: date('po_date'),
  vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id),
  vendorName: text('vendor_name'), // เดิมเก็บชื่อ string — เก็บไว้สำหรับ match-by-name + ETL
  status: poStatusEnum('status').default('Draft'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  remarks: text('remarks'),
  totalAmount: numeric('total_amount', { precision: 14, scale: 2 }),
  createdBy: text('created_by'),
  expectedDate: date('expected_date'),
});

export const poItems = pgTable('po_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  poId: bigint('po_id', { mode: 'number' }).references(() => purchaseOrders.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  orderQty: numeric('order_qty'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
  uom: text('uom'),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  receivedQty: numeric('received_qty').default('0'),
  status: text('status').default('Open'),
});

export const poDeliveries = pgTable('po_deliveries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  poId: bigint('po_id', { mode: 'number' }).references(() => purchaseOrders.id),
  deliveryNo: integer('delivery_no'),
  itemId: text('item_id'),
  scheduledQty: numeric('scheduled_qty'),
  scheduledDate: date('scheduled_date'),
  receivedQty: numeric('received_qty').default('0'),
  status: text('status').default('Pending'),
});

export const goodsReceipts = pgTable('goods_receipts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  grNo: text('gr_no').notNull().unique(),
  grDate: date('gr_date'),
  poNo: text('po_no'),
  vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id),
  vendorName: text('vendor_name'),
  receivedBy: text('received_by'),
  remarks: text('remarks'),
});

export const grItems = pgTable('gr_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  grId: bigint('gr_id', { mode: 'number' }).references(() => goodsReceipts.id),
  poNo: text('po_no'),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  poQty: numeric('po_qty'),
  receivedQty: numeric('received_qty'),
  uom: text('uom'),
  lotNo: text('lot_no'),
  expiryDate: date('expiry_date'),
  unitCost: numeric('unit_cost', { precision: 14, scale: 2 }),
  remarks: text('remarks'),
});

export const grClaims = pgTable('gr_claims', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  claimNo: text('claim_no').notNull().unique(),
  claimDate: date('claim_date'),
  grNo: text('gr_no'),
  poNo: text('po_no'),
  vendorId: bigint('vendor_id', { mode: 'number' }).references(() => vendors.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  grQty: numeric('gr_qty'),
  claimQty: numeric('claim_qty'),
  uom: text('uom'),
  reason: text('reason'),
  imageKey: text('image_key'),
  status: text('status').default('Open'),
  supplierAction: text('supplier_action'),
  resolvedBy: text('resolved_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  remarks: text('remarks'),
});

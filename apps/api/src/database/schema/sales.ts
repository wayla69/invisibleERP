import { pgTable, bigserial, bigint, text, numeric, date, timestamp, boolean } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { orderStatusEnum, claimStatusEnum, posStatusEnum } from './enums';

// tbl_sales_orders (denorm, no PK) → header + lines + claims
export const orders = pgTable('orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  orderNo: text('order_no').notNull().unique(), // SO-YYYYMMDD-HHMM
  orderDate: date('order_date'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  status: orderStatusEnum('status').default('Pending'),
  estimatedDelivery: date('estimated_delivery'),
  currency: text('currency').default('THB'),
  fxRate: numeric('fx_rate', { precision: 18, scale: 8 }).default('1'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const orderLines = pgTable('order_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  orderId: bigint('order_id', { mode: 'number' }).references(() => orders.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  orderQty: numeric('order_qty'),
  stockUom: text('stock_uom'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
  totalPrice: numeric('total_price', { precision: 14, scale: 2 }),
  status: orderStatusEnum('status').default('Pending'),
  receivedQty: numeric('received_qty').default('0'),
});

export const orderClaims = pgTable('order_claims', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  orderLineId: bigint('order_line_id', { mode: 'number' }).references(() => orderLines.id),
  claimedQty: numeric('claimed_qty'),
  claimReason: text('claim_reason'),
  claimImageKey: text('claim_image_key'),
  adminStatus: claimStatusEnum('admin_status').default('Waiting'),
  rejectReason: text('reject_reason'),
});

// Customer-portal POS (retail)
export const custPosSales = pgTable('cust_pos_sales', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  saleNo: text('sale_no').notNull().unique(), // SALE-{tenant4}-{ts}
  saleDate: date('sale_date'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  subtotal: numeric('subtotal', { precision: 14, scale: 2 }),
  discount: numeric('discount', { precision: 14, scale: 2 }),
  taxAmount: numeric('tax_amount', { precision: 14, scale: 2 }), // VAT via TaxProvider
  total: numeric('total', { precision: 14, scale: 2 }),
  tip: numeric('tip', { precision: 14, scale: 2 }).default('0'), // staff tip — liability (2300), excluded from subtotal+VAT
  currency: text('currency').default('THB'),
  fxRate: numeric('fx_rate', { precision: 18, scale: 8 }).default('1'),
  paymentMethod: text('payment_method').default('Cash'),
  pointsUsed: numeric('points_used').default('0'),
  pointsEarned: numeric('points_earned').default('0'),
  status: posStatusEnum('status').default('Completed'),
  notes: text('notes'),
  createdBy: text('created_by'),
});

export const custPosItems = pgTable('cust_pos_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  saleId: bigint('sale_id', { mode: 'number' }).references(() => custPosSales.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  qty: numeric('qty'),
  uom: text('uom'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
  discountPct: numeric('discount_pct').default('0'),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  isCustom: boolean('is_custom').default(false),
});

export const salesReturns = pgTable('sales_returns', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  returnNo: text('return_no').notNull().unique(),
  returnDate: date('return_date'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  orderNo: text('order_no'),
  returnType: text('return_type').default('Return'),
  status: text('status').default('Approved'),
  totalAmount: numeric('total_amount', { precision: 14, scale: 2 }),
  remarks: text('remarks'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

export const returnItems = pgTable('return_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  returnId: bigint('return_id', { mode: 'number' }).references(() => salesReturns.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  returnQty: numeric('return_qty'),
  uom: text('uom'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  reason: text('reason'),
  returnToStock: boolean('return_to_stock').default(true),
});

export const pendingOrders = pgTable('pending_orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  pendingNo: text('pending_no').notNull().unique(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  createdAt: timestamp('created_at', { withTimezone: true }),
  status: text('status').default('Draft'),
  triggerType: text('trigger_type').default('Auto'),
  totalItems: numeric('total_items'),
  notes: text('notes'),
});

export const pendingOrderItems = pgTable('pending_order_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  pendingId: bigint('pending_id', { mode: 'number' }).references(() => pendingOrders.id),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  suggestedQty: numeric('suggested_qty'),
  finalQty: numeric('final_qty'),
  uom: text('uom'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
  triggerReason: text('trigger_reason'),
});

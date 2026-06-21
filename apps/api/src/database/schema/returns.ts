import { pgTable, bigserial, bigint, text, numeric, date, timestamp, boolean } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// POS item-level returns (คืนสินค้า/คืนเงิน). 1 return → N returned lines.
// Links sale_no → original PAY- (refund) and the issued REF-; credit-note hook ready.
export const posReturns = pgTable('pos_returns', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  returnNo: text('return_no').notNull().unique(),       // RTN-YYYYMMDD-NNN
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  saleNo: text('sale_no').notNull(),
  paymentNo: text('payment_no'),
  refundNo: text('refund_no'),
  refundMethod: text('refund_method').default('Cash'),
  returnDate: date('return_date'),
  reason: text('reason'),
  subtotalReturned: numeric('subtotal_returned', { precision: 14, scale: 2 }).default('0'),
  vatReturned: numeric('vat_returned', { precision: 14, scale: 2 }).default('0'),
  totalReturned: numeric('total_returned', { precision: 14, scale: 2 }).default('0'),
  restocked: boolean('restocked').default(false),
  journalNo: text('journal_no'),
  creditNoteNo: text('credit_note_no'),
  status: text('status').default('Completed'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const posReturnItems = pgTable('pos_return_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  returnId: bigint('return_id', { mode: 'number' }).references(() => posReturns.id),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  saleItemId: bigint('sale_item_id', { mode: 'number' }),
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  returnQty: numeric('return_qty').notNull(),
  uom: text('uom'),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  restocked: boolean('restocked').default(false),
});

export type PosReturn = typeof posReturns.$inferSelect;

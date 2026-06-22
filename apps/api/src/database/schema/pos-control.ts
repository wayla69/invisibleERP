import { pgTable, bigserial, bigint, text, numeric, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Parked/held POS carts — recall later (retail "park sale").
export const posHeldOrders = pgTable('pos_held_orders', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  holdNo: text('hold_no').notNull(),
  label: text('label'),
  customerName: text('customer_name'),
  cart: jsonb('cart').notNull(),
  status: text('status').default('Held'), // Held | Recalled | Discarded
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  recalledAt: timestamp('recalled_at', { withTimezone: true }),
});

// Manager-override audit (void / over-threshold discount / price override / no-sale / return).
export const posOverrides = pgTable('pos_overrides', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  overrideNo: text('override_no').notNull(),
  saleNo: text('sale_no'),
  action: text('action').notNull(), // void | discount | price_override | no_sale | return
  reasonCode: text('reason_code'),
  reason: text('reason'),
  amount: numeric('amount', { precision: 14, scale: 2 }),
  requestedBy: text('requested_by'),
  approvedBy: text('approved_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

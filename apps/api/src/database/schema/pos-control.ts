import { pgTable, bigserial, bigint, text, numeric, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
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
  // docs/52 Phase 4b — for a `discount` authorization: the max discount % this supervisor authorization
  // covers. A sale whose over-cap discount ≤ this may consume the (single-use) authorization. NULL for the
  // legacy post-hoc override-audit rows.
  authorizedPct: numeric('authorized_pct', { precision: 6, scale: 3 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// docs/52 Phase 4b — per-tenant POS discount-authority policy. A manual line/bill discount above the cap
// requires a supervisor's authorization at the till (maker-checker; SoD R08 — the same duty that authorizes
// refunds/voids, segregated from selling). Both caps NULL = no cap (the till applies discounts freely, the
// pre-4b behaviour) — a shop OPTS IN to discount governance by setting a cap.
export const posDiscountSettings = pgTable('pos_discount_settings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  maxLineDiscountPct: numeric('max_line_discount_pct', { precision: 6, scale: 3 }), // NULL = no per-line cap
  maxBillDiscountPct: numeric('max_bill_discount_pct', { precision: 6, scale: 3 }), // NULL = no bill cap
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byTenant: index('idx_pos_discount_settings_tenant').on(t.tenantId) }));

import { pgTable, bigserial, bigint, text, numeric, timestamp, pgEnum, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Payments + tender layer (move #3) — 1 sale → N tenders; proof money moved
export const paymentStatusEnum = pgEnum('payment_status', ['Pending', 'Authorized', 'Captured', 'Failed', 'Refunded', 'Voided']);
export const tillStatusEnum = pgEnum('till_status', ['Open', 'Closed']);

export const payments = pgTable('payments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  paymentNo: text('payment_no').notNull().unique(), // PAY-YYYYMMDD-NNN
  saleNo: text('sale_no'), // tender attaches to a sale/order
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  tillSessionId: bigint('till_session_id', { mode: 'number' }),
  method: text('method').notNull(), // Cash | Card | QR | PromptPay | Transfer | Wallet
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
  tip: numeric('tip', { precision: 18, scale: 4 }).default('0'), // tip portion of this tender — NOT in amount, excluded from cash recon
  currency: text('currency').default('THB'),
  gateway: text('gateway').default('mock'), // mock | stripe | promptpay | adyen
  gatewayRef: text('gateway_ref'),
  // Client-supplied idempotency token for a tender attempt. A retried POST /api/payments carrying the
  // same key collapses to the original row instead of charging twice. NULL for keyless legacy tenders
  // (Postgres treats NULLs as distinct, so the unique index never blocks them).
  idempotencyKey: text('idempotency_key'),
  status: paymentStatusEnum('status').default('Captured'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
}, (t) => ({
  uxIdem: uniqueIndex('ux_payments_idem').on(t.idempotencyKey), // race backstop for double-submit
}));

export const paymentRefunds = pgTable('payment_refunds', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  refundNo: text('refund_no').notNull().unique(), // REF-YYYYMMDD-NNN
  paymentNo: text('payment_no').notNull(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  // Till the cash physically LEAVES at refund time (the drawer open when the refund is processed),
  // NOT the original sale's till — so a refund of a prior shift's cash sale reduces the current
  // drawer, never a closed shift's expected cash (no phantom overage). Null = non-cash / no open till.
  tillSessionId: bigint('till_session_id', { mode: 'number' }),
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
  reason: text('reason'),
  status: text('status').default('Refunded'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const tillSessions = pgTable('till_sessions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  sessionNo: text('session_no').notNull().unique(), // TILL-YYYYMMDDHHMMSS
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  openedBy: text('opened_by'),
  openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow(),
  openingFloat: numeric('opening_float', { precision: 18, scale: 4 }).default('0'),
  closedBy: text('closed_by'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closingCount: numeric('closing_count', { precision: 18, scale: 4 }),
  expectedCash: numeric('expected_cash', { precision: 18, scale: 4 }),
  variance: numeric('variance', { precision: 18, scale: 4 }),
  denominations: jsonb('denominations'),   // {"1000":2,"500":1,...} captured on close
  status: tillStatusEnum('status').default('Open'),
});

export type Payment = typeof payments.$inferSelect;

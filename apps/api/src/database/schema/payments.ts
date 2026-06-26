import { pgTable, bigserial, bigint, text, numeric, timestamp, pgEnum, jsonb, uniqueIndex, index } from 'drizzle-orm/pg-core';
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
  // Tender reconciliation / receipt rebuilds look up WHERE sale_no=?; tenant reports range over created_at.
  bySale: index('idx_payments_sale').on(t.saleNo),
  byTenantCreated: index('idx_payments_tenant_created').on(t.tenantId, t.createdAt),
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
}, (t) => ({
  // Refund history is fetched WHERE payment_no=? (e.g. over-refund guard sums prior refunds).
  byPayment: index('idx_refunds_payment').on(t.paymentNo),
}));

// REV-16 — refund maker-checker. A standalone refund at/above the materiality threshold is a REQUEST
// that moves no money until a DIFFERENT user approves it (SoD); below the threshold refunds run immediately,
// and a refund that is part of a goods-return (the return is the authorizing document) is never gated.
export const refundRequests = pgTable('refund_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  paymentNo: text('payment_no').notNull(),
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
  reason: text('reason'),
  status: text('status').notNull().default('PendingApproval'), // PendingApproval | Approved | Rejected
  requestedBy: text('requested_by'),
  approvedBy: text('approved_by'),               // checker — must differ from requested_by
  refundNo: text('refund_no'),                   // the REF- once approved
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
}, (t) => ({
  byStatus: index('idx_refund_requests_status').on(t.tenantId, t.status),
}));

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
  // POS-01: cash over/short is posted to GL (5830↔1000) on close. A variance over the materiality
  // threshold posts a DRAFT JE and waits for a different user (manager) to approve — maker-checker.
  varianceJournalNo: text('variance_journal_no'),                                  // JE-... for the over/short posting
  varianceStatus: text('variance_status').notNull().default('NotRequired'),        // NotRequired | PendingApproval | Approved | Rejected
  varianceApprovedBy: text('variance_approved_by'),
  varianceApprovedAt: timestamp('variance_approved_at', { withTimezone: true }),
});

export type Payment = typeof payments.$inferSelect;

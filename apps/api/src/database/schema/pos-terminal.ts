import { pgTable, bigserial, bigint, text, numeric, integer, date, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Paired card terminals (provider = mock | omise | 2c2p | gbprime).
export const paymentTerminals = pgTable('payment_terminals', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  terminalCode: text('terminal_code').notNull(),
  name: text('name'),
  provider: text('provider').default('mock'),
  status: text('status').default('active'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Card payment intents — sale or pre-auth; capture later; settle in a batch.
export const paymentIntents = pgTable('payment_intents', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  intentNo: text('intent_no').notNull(),
  saleNo: text('sale_no'),
  terminalCode: text('terminal_code'),
  provider: text('provider').default('mock'),
  providerRef: text('provider_ref'),
  type: text('type').default('sale'), // sale | preauth
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  capturedAmount: numeric('captured_amount', { precision: 14, scale: 2 }).default('0'),
  currency: text('currency').default('THB'),
  status: text('status').default('RequiresPayment'), // RequiresPayment|Authorized|Captured|Voided|Refunded|Failed
  settlementBatchNo: text('settlement_batch_no'),
  // C5 (docs/50 Wave 5) — tip-on-terminal: tip added at charge time, or the classic capture-time tip
  // adjustment on a bar-tab pre-auth (captured_amount then includes the tip).
  tipAmount: numeric('tip_amount', { precision: 14, scale: 2 }).default('0'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
});

// Daily settlement batches reconciled against captured intents.
export const settlementBatches = pgTable('settlement_batches', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  batchNo: text('batch_no').notNull(),
  provider: text('provider'),
  batchDate: date('batch_date'),
  gross: numeric('gross', { precision: 14, scale: 2 }).default('0'),
  fees: numeric('fees', { precision: 14, scale: 2 }).default('0'),
  net: numeric('net', { precision: 14, scale: 2 }).default('0'),
  txnCount: integer('txn_count').default(0),
  status: text('status').default('Open'), // Open | Settled | Reconciled
  reconciledBy: text('reconciled_by'),
  // C5 — acquirer-report reconciliation (real match, not a status flip): Σ matched report amounts + the
  // count of discrepancy lines from the last import.
  reconciledAmount: numeric('reconciled_amount', { precision: 14, scale: 2 }),
  discrepancyCount: integer('discrepancy_count').default(0),
  reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// C5 (docs/50 Wave 5) — PSP webhook event-id dedup: one row per (provider, event_id), so a redelivered
// event (same id, possibly a stale/different status) acks as duplicate_event and can never re-process.
export const pspWebhookEvents = pgTable('psp_webhook_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  provider: text('provider').notNull(),
  eventId: text('event_id').notNull(),
  providerRef: text('provider_ref'),
  status: text('status'),
  outcome: text('outcome'),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow(),
});

// C5 — imported acquirer settlement-report lines matched per intent.
export const settlementLines = pgTable('settlement_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  batchNo: text('batch_no').notNull(),
  providerRef: text('provider_ref'),
  intentNo: text('intent_no'),
  amount: numeric('amount', { precision: 14, scale: 2 }).default('0'),
  fee: numeric('fee', { precision: 14, scale: 2 }).default('0'),
  matchStatus: text('match_status').notNull().default('matched'), // matched | amount_mismatch | missing_intent | unreported_intent
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

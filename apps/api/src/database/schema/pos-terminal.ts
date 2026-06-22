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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

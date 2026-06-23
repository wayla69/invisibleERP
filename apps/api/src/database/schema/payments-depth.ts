// Phase 8 — payments depth: customer deposits (prepaid liability), house/charge accounts (AR with a credit
// limit + foreign-currency settlement), and card-surcharge config. Each money movement posts its own
// balanced JE via LedgerService; the sale builders are untouched.
import { pgTable, bigserial, bigint, text, numeric, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const customerDeposits = pgTable('customer_deposits', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  depositNo: text('deposit_no').notNull(),
  memberId: bigint('member_id', { mode: 'number' }),
  customerName: text('customer_name'),
  purpose: text('purpose').default('booking'),         // booking | tab | other
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  appliedAmount: numeric('applied_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  refundedAmount: numeric('refunded_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  status: text('status').notNull().default('open'),     // open | applied | refunded | closed
  saleNo: text('sale_no'),
  journalNo: text('journal_no'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const houseAccounts = pgTable('house_accounts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  accountNo: text('account_no').notNull(),
  memberId: bigint('member_id', { mode: 'number' }),
  name: text('name').notNull(),
  creditLimit: numeric('credit_limit', { precision: 14, scale: 2 }).notNull().default('0'),
  balance: numeric('balance', { precision: 14, scale: 2 }).notNull().default('0'), // owed
  status: text('status').notNull().default('active'),   // active | hold | closed
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const houseAccountEntries = pgTable('house_account_entries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  accountId: bigint('account_id', { mode: 'number' }).notNull(),
  entryNo: text('entry_no').notNull(),
  type: text('type').notNull(),                         // charge | payment | adjustment
  saleNo: text('sale_no'),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  balanceAfter: numeric('balance_after', { precision: 14, scale: 2 }).notNull(),
  currency: text('currency').default('THB'),
  fxRate: numeric('fx_rate', { precision: 18, scale: 8 }).default('1'),
  fxGainLoss: numeric('fx_gain_loss', { precision: 14, scale: 2 }).default('0'),
  journalNo: text('journal_no'),
  memo: text('memo'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const paymentSurcharges = pgTable('payment_surcharges', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  method: text('method').notNull(),                     // Card | Amex | ...
  pct: numeric('pct', { precision: 6, scale: 3 }).notNull().default('0'),
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type CustomerDeposit = typeof customerDeposits.$inferSelect;
export type HouseAccount = typeof houseAccounts.$inferSelect;
export type HouseAccountEntry = typeof houseAccountEntries.$inferSelect;

import { pgTable, bigserial, bigint, text, numeric, date, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ระหว่างกิจการ — Intercompany. One IC txn = TWO mirrored balanced GL entries (Dr 1150 Due-From in the
// creditor / Dr…Cr 2150 Due-To in the debtor). tenant_id = FROM (creditor/owning) tenant → RLS owner.
export const icCategoryEnum = pgEnum('ic_category', ['shared-cost', 'transfer', 'loan']);
export const icStatusEnum = pgEnum('ic_status', ['Open', 'Partial', 'Settled']);

export const icTransactions = pgTable('ic_transactions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  icNo: text('ic_no').notNull().unique(),                 // IC-YYYYMMDD-NNN
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // = fromTenantId (RLS owner)
  fromTenantId: bigint('from_tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  toTenantId: bigint('to_tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  txnDate: date('txn_date').notNull(),
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
  settledAmount: numeric('settled_amount', { precision: 18, scale: 4 }).notNull().default('0'),
  currency: text('currency').default('THB'),
  category: icCategoryEnum('category').notNull().default('shared-cost'),
  description: text('description'),
  status: icStatusEnum('status').notNull().default('Open'),
  fromJournalNo: text('from_journal_no'),
  toJournalNo: text('to_journal_no'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byFrom: index('idx_ic_from').on(t.fromTenantId), byTo: index('idx_ic_to').on(t.toTenantId), byStatus: index('idx_ic_status').on(t.status) }));

export const icSettlements = pgTable('ic_settlements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  icNo: text('ic_no').notNull().references(() => icTransactions.icNo),
  settleDate: date('settle_date').notNull(),
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
  fromJournalNo: text('from_journal_no'),
  toJournalNo: text('to_journal_no'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byIc: index('idx_ic_settle_ic').on(t.icNo) }));

export type IcTransaction = typeof icTransactions.$inferSelect;
export type IcSettlement = typeof icSettlements.$inferSelect;

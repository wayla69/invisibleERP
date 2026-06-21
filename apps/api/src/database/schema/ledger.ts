import { pgTable, bigserial, bigint, text, numeric, date, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Double-entry General Ledger (move #2) — เปลี่ยน "POS add-on" → "ERP" จริง
export const accountTypeEnum = pgEnum('account_type', ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense']);
export const journalStatusEnum = pgEnum('journal_status', ['Draft', 'Posted', 'Voided']);
export const periodStatusEnum = pgEnum('period_status', ['Open', 'Closed']);

// Chart of Accounts
export const accounts = pgTable('accounts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  code: text('code').notNull().unique(), // e.g. '1000' Cash, '1100' AR, '4000' Revenue
  name: text('name').notNull(),
  type: accountTypeEnum('type').notNull(),
  parentCode: text('parent_code'),
  currency: text('currency').default('THB'),
  active: text('active').default('true'),
});

export const fiscalPeriods = pgTable('fiscal_periods', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  code: text('code').notNull().unique(), // 'YYYY-MM'
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  status: periodStatusEnum('status').default('Open'),
});

// Journal entry header — balanced by construction (Σdebit = Σcredit), enforced in LedgerService
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    entryNo: text('entry_no').notNull().unique(), // JE-YYYYMMDD-NNN
    entryDate: date('entry_date').notNull(),
    period: text('period'), // FK-ish to fiscal_periods.code
    memo: text('memo'),
    source: text('source'), // 'POS' | 'AR' | 'AP' | 'GR' | 'Manual' | 'Payment'
    sourceRef: text('source_ref'), // originating doc no (sale_no / invoice_no / ...)
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    currency: text('currency').default('THB'),
    status: journalStatusEnum('status').default('Posted'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ bySource: index('idx_je_source').on(t.source, t.sourceRef) }),
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    entryId: bigint('entry_id', { mode: 'number' }).notNull().references(() => journalEntries.id),
    accountCode: text('account_code').notNull(),
    debit: numeric('debit', { precision: 18, scale: 4 }).default('0'),
    credit: numeric('credit', { precision: 18, scale: 4 }).default('0'),
    currency: text('currency').default('THB'),
    memo: text('memo'),
    costCenterCode: text('cost_center_code'), // nullable accounting dimension (Tier 3); untagged = Unassigned
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  },
  (t) => ({ byAccount: index('idx_jl_account').on(t.accountCode), byCc: index('idx_jl_cc').on(t.costCenterCode) }),
);

export type Account = typeof accounts.$inferSelect;

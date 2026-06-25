import { pgTable, bigserial, bigint, text, numeric, date, timestamp, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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

// Per-tenant fiscal calendar. tenant_id added in 0043 so one tenant's period/year-end close
// no longer locks every other tenant (the old global `code` unique did exactly that).
export const fiscalPeriods = pgTable(
  'fiscal_periods',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    code: text('code').notNull(), // 'YYYY-MM'
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: periodStatusEnum('status').default('Open'),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  },
  (t) => ({ uqTenantCode: uniqueIndex('uq_fiscal_periods_tenant_code').on(t.tenantId, t.code) }),
);

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
    ledgerCode: text('ledger_code'), // NULL = shared across ALL ledgers; a code = adjustment to that ledger only
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    currency: text('currency').default('THB'),
    status: journalStatusEnum('status').default('Posted'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    bySource: index('idx_je_source').on(t.source, t.sourceRef),
    byLedger: index('idx_je_ledger').on(t.ledgerCode),
    // Period/tenant financial reports (trial balance, P&L, balance sheet) filter status='Posted' over an
    // entry_date range, scoped by tenant. Without these the report scans every journal entry ever posted.
    byTenantDate: index('idx_je_tenant_date').on(t.tenantId, t.entryDate),
    byStatusDate: index('idx_je_status_date').on(t.status, t.entryDate),
    // H4 — structural idempotency: one posting per (tenant, source, source_ref, ledger). COALESCE so a
    // NULL tenant/ledger still collides (Postgres NULLs are otherwise distinct, which would defeat this).
    // Partial: manual entries carry no source_ref and are intentionally exempt (many allowed).
    uxIdem: uniqueIndex('ux_je_idem')
      .on(sql`coalesce(${t.tenantId}, 0)`, t.source, t.sourceRef, sql`coalesce(${t.ledgerCode}, '')`)
      .where(sql`${t.sourceRef} IS NOT NULL`),
  }),
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
  (t) => ({
    byAccount: index('idx_jl_account').on(t.accountCode),
    byCc: index('idx_jl_cc').on(t.costCenterCode),
    // entry_id is the join key for EVERY GL report (header ⋈ lines). journal_lines is the largest financial
    // table; without this every trial-balance/statement/consolidation does a full scan + hash join.
    byEntry: index('idx_jl_entry').on(t.entryId),
    byTenant: index('idx_jl_tenant').on(t.tenantId),
  }),
);

export type Account = typeof accounts.$inferSelect;

import { pgTable, bigserial, bigint, text, numeric, boolean, date, timestamp, jsonb, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants';

// Double-entry General Ledger (move #2) — เปลี่ยน "POS add-on" → "ERP" จริง
export const accountTypeEnum = pgEnum('account_type', ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense']);
export const journalStatusEnum = pgEnum('journal_status', ['Draft', 'Posted', 'Voided']);
export const periodStatusEnum = pgEnum('period_status', ['Open', 'Closed']);

// Account Groups — tenant-scoped (nullable: NULL = global template visible to all tenants)
export const accountGroups = pgTable('account_groups', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  nameTh: text('name_th').notNull(),
  nameEn: text('name_en').notNull(),
  type: accountTypeEnum('type').notNull(),
  parentGroupId: bigint('parent_group_id', { mode: 'number' }),
  sortOrder: bigint('sort_order', { mode: 'number' }).default(0),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqCode: uniqueIndex('uq_account_groups').on(sql`COALESCE(${t.tenantId}, 0)`, t.code),
}));

// Chart of Accounts
export const accounts = pgTable('accounts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  code: text('code').notNull().unique(), // e.g. '1000' Cash, '1100' AR, '4000' Revenue
  name: text('name').notNull(),
  nameTh: text('name_th'),
  type: accountTypeEnum('type').notNull(),
  parentCode: text('parent_code'),
  currency: text('currency').default('THB'),
  active: text('active').default('true'),
  accountGroupId: bigint('account_group_id', { mode: 'number' }),
  isControl: boolean('is_control').default(false),
  controlSubledger: text('control_subledger'),  // 'AR'|'AP'|'INV'|'FA' or null
  normalBalance: text('normal_balance').default('D'), // 'D'=debit | 'C'=credit
  isPostable: boolean('is_postable').default(true),
  requireDimension: jsonb('require_dimension'),  // e.g. {"branch":true}
  effectiveFrom: date('effective_from'),
  effectiveTo: date('effective_to'),
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

// Recurring / template journal entries (GL-08). A balanced template (lines stored as JSON) + a cadence
// (daily/weekly/monthly) + a next_run_date. The scheduled job `gl_recurring_journals` posts each due
// template as a DRAFT JE through the normal maker-checker flow (GL-05) and rolls next_run_date forward.
export const recurringJournals = pgTable(
  'recurring_journals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    name: text('name').notNull(),
    frequency: text('frequency').notNull(), // 'daily' | 'weekly' | 'monthly'
    memo: text('memo'),
    ledgerCode: text('ledger_code'), // NULL = shared across all ledgers
    currency: text('currency').default('THB'),
    lines: jsonb('lines').notNull(), // [{ account_code, debit?, credit?, memo?, cost_center? }]
    active: text('active').default('true'),
    nextRunDate: date('next_run_date'),
    lastRunDate: date('last_run_date'),
    lastEntryNo: text('last_entry_no'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byDue: index('idx_recurring_due').on(t.active, t.nextRunDate) }),
);

// Prepaid amortization schedules (GL-09). A prepaid asset (annual insurance, rent paid up front, etc.) is
// registered once with a total and a term; the scheduled job amortizes a straight-line slice each period
// (Dr expense / Cr 1280 prepaid), the last period taking the remainder so it fully clears.
export const prepaidSchedules = pgTable(
  'prepaid_schedules',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    scheduleNo: text('schedule_no').notNull().unique(), // PPD-YYYYMMDD-NNN
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    name: text('name').notNull(),
    totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull(),
    months: bigint('months', { mode: 'number' }).notNull(),
    amortizedAmount: numeric('amortized_amount', { precision: 14, scale: 2 }).default('0'),
    periodsPosted: bigint('periods_posted', { mode: 'number' }).default(0),
    expenseAccount: text('expense_account').default('5100'),
    prepaidAccount: text('prepaid_account').default('1280'),
    startDate: date('start_date'),
    nextRunDate: date('next_run_date'),
    status: text('status').notNull().default('active'), // active | complete
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byDue: index('idx_prepaid_due').on(t.status, t.nextRunDate) }),
);

// Per-tenant Chart-of-Accounts overlay (0139). The canonical `accounts` table is the GLOBAL, immutable
// posting universe (the engine hard-references its codes); this table curates a PER-TENANT VIEW over it:
// which canonical accounts a tenant sees as "active", and how they are named/grouped on that tenant's
// chart. Materialised from an industry template at signup (LedgerService.provisionTenantCoA). It NEVER
// gates postings — reports surface any account that is active OR carries activity. tenant_id → RLS-scoped.
export const tenantAccounts = pgTable(
  'tenant_accounts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    accountCode: text('account_code').notNull(), // FK-ish to accounts.code (canonical universe)
    displayName: text('display_name'), // industry display name (EN); null = use canonical accounts.name
    displayNameTh: text('display_name_th'),
    groupLabel: text('group_label'), // section heading (defaults to account type)
    active: boolean('active').default(true),
    sortOrder: bigint('sort_order', { mode: 'number' }).default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ uqTenantCode: uniqueIndex('uq_tenant_accounts_tenant_code').on(t.tenantId, t.accountCode) }),
);

export type Account = typeof accounts.$inferSelect;
export type AccountGroup = typeof accountGroups.$inferSelect;
export type TenantAccount = typeof tenantAccounts.$inferSelect;

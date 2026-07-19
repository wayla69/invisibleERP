import { pgTable, bigserial, bigint, text, numeric, boolean, date, timestamp, jsonb, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants';

// Double-entry General Ledger (move #2) — เปลี่ยน "POS add-on" → "ERP" จริง
export const accountTypeEnum = pgEnum('account_type', ['Asset', 'Liability', 'Equity', 'Revenue', 'Expense']);
export const journalStatusEnum = pgEnum('journal_status', ['Draft', 'Posted', 'Voided']);
// 'Locked' (WS2.1, GL-15/GL-16) is the hard-close state: a Locked period rejects ALL postEntry postings
// except the system year-end closing entry (source='CLOSE'), regardless of allowClosedPeriod.
export const periodStatusEnum = pgEnum('period_status', ['Open', 'Closed', 'Locked']);

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
  // docs/43 PR-8 (0346): a balance-sheet account self-declares its indirect-SCF bucket
  // (operating|investing|financing|addback) + current/non-current; the hardcoded CF_CLASSIFY map and
  // the metrics account lists stay as FALLBACKS for rows that leave these null.
  cfBucket: text('cf_bucket'),
  cfLabel: text('cf_label'),
  isCurrent: boolean('is_current'),
  // 0439 — statement-section binding: which line of the Balance Sheet / Income Statement this account
  // rolls into (own column → canonical default map → type fallback; see ledger-statement-sections.ts).
  bsGroup: text('bs_group'),   // current_asset | noncurrent_asset | current_liability | noncurrent_liability | equity
  isGroup: text('is_group'),   // revenue | cogs | selling_admin | other_income | other_expense | finance_cost | tax
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
    // WS2.2 (GL-17) — GL immutability & reversal. postedAt stamps when an entry reached Posted; a posted
    // entry is immutable (DB trigger + app guard) and may only be corrected by a contra REVERSAL entry.
    // reversalOf points the contra entry at the original; isReversed flags the original once reversed.
    postedAt: timestamp('posted_at', { withTimezone: true }),
    reversalOf: bigint('reversal_of', { mode: 'number' }),
    isReversed: boolean('is_reversed').default(false),
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
    branchId: bigint('branch_id', { mode: 'number' }),
    projectId: bigint('project_id', { mode: 'number' }),
    departmentId: bigint('department_id', { mode: 'number' }),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  },
  (t) => ({
    byAccount: index('idx_jl_account').on(t.accountCode),
    byCc: index('idx_jl_cc').on(t.costCenterCode),
    // entry_id is the join key for EVERY GL report (header ⋈ lines). journal_lines is the largest financial
    // table; without this every trial-balance/statement/consolidation does a full scan + hash join.
    byEntry: index('idx_jl_entry').on(t.entryId),
    byTenant: index('idx_jl_tenant').on(t.tenantId),
    byBranch: index('idx_jl_branch').on(t.branchId),
    byProject: index('idx_jl_project').on(t.projectId),
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
    // 0419 (docs/50 Wave 1 B2) — auto-reverse the posted accrual in the next business month (monthly only).
    autoReverse: text('auto_reverse').default('false'),
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

// GL allocation cycles (GL-23, migration 0307). A periodic cost-allocation cycle distributes a source
// POOL (an amount out of a source account / cost-center) to a set of targets by fixed ratio, a measured
// driver, or a statistical key (headcount / sqm). Each due run posts ONE balanced JE — Cr the source pool,
// Dr each target its proportional share (last target absorbs the rounding remainder) — as a DRAFT through
// the normal maker-checker flow (GL-05), riding the recurring rail (GL-08 pattern). Idempotent per period
// via the (tenant,source,source_ref,ledger) JE key + next_run_date advance.
export const allocationCycles = pgTable(
  'allocation_cycles',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    cycleNo: text('cycle_no').notNull().unique(), // ALC-YYYYMMDD-NNN
    name: text('name').notNull(),
    method: text('method').notNull().default('ratio'), // 'ratio' | 'driver' | 'statistical'
    frequency: text('frequency').notNull(), // 'daily' | 'weekly' | 'monthly'
    poolAmount: numeric('pool_amount', { precision: 18, scale: 4 }).notNull(), // amount distributed each run
    sourceAccount: text('source_account').notNull(), // credited (relieved) each run
    sourceCostCenter: text('source_cost_center'), // optional dimension on the source credit leg
    ledgerCode: text('ledger_code'), // NULL = shared across all ledgers
    currency: text('currency').default('THB'),
    memo: text('memo'),
    active: text('active').default('true'),
    nextRunDate: date('next_run_date'),
    lastRunDate: date('last_run_date'),
    lastEntryNo: text('last_entry_no'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  // Leading (tenant_id, …) index for the RLS tenant predicate (R1-1) + the due scan.
  (t) => ({ byTenantDue: index('idx_alloc_cycles_tenant_due').on(t.tenantId, t.nextRunDate) }),
);

// Allocation targets — the child rows of a cycle. Each target receives pool × (basis / Σbasis); `basis` is
// the fixed ratio (ratio method) or the driver / statistical-key value (driver / statistical method — the
// engine distributes proportionally either way). target_account defaults to the cycle's source_account for
// a pure cost-center reallocation (same account, different cost center).
export const allocationTargets = pgTable(
  'allocation_targets',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    cycleId: bigint('cycle_id', { mode: 'number' }).notNull().references(() => allocationCycles.id),
    targetAccount: text('target_account'), // NULL = cycle.source_account (pure cost-center reallocation)
    costCenter: text('cost_center'), // consuming cost-center dimension on the debit leg
    basis: numeric('basis', { precision: 18, scale: 4 }).notNull().default('0'), // weight / driver / stat key
    memo: text('memo'),
    sortOrder: bigint('sort_order', { mode: 'number' }).default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  // Leading (tenant_id, …) index (R1-1) that also serves the by-cycle child fetch.
  (t) => ({ byTenantCycle: index('idx_alloc_targets_tenant_cycle').on(t.tenantId, t.cycleId) }),
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

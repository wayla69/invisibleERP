// Accounting Tier 3 — Budget vs Actual (งบประมาณเทียบจริง). Reference data only — NOT journal entries.
// One row per account per period (YYYY-MM), optionally per cost center. tenant_id → RLS. No GL effect.
import { pgTable, bigserial, bigint, text, numeric, timestamp, integer, boolean, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const budgets = pgTable('budgets', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  fiscalYear: integer('fiscal_year').notNull(),
  accountCode: text('account_code').notNull(),
  costCenterCode: text('cost_center_code'),   // nullable → tenant-wide budget for the account
  period: text('period').notNull(),           // 'YYYY-MM'
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull().default('0'),
  notes: text('notes'),
  // BUD-01 maker-checker (0141): an upserted budget is PendingApproval and excluded from budget-vs-actual until
  // a DIFFERENT user approves it. DEFAULT 'Approved' keeps existing rows + direct seeds usable.
  status: text('status').notNull().default('Approved'), // Approved | PendingApproval | Rejected
  requestedBy: text('requested_by'),
  approvedBy: text('approved_by'),                       // checker — must differ from requested_by
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdBy: text('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byAccount: index('idx_budget_account').on(t.accountCode, t.period), byStatus: index('idx_budget_status').on(t.tenantId, t.status) }));

export type Budget = typeof budgets.$inferSelect;

// ELC-06 — management budget-variance review sign-off. Recorded evidence that material budget-vs-actual
// variances were reviewed by management with a follow-up note. One row per recorded review (append-only).
export const budgetReviews = pgTable('budget_reviews', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  fiscalYear: integer('fiscal_year').notNull(),
  period: text('period'),                      // 'YYYY-MM' or null = full year
  costCenterCode: text('cost_center_code'),
  materialCount: integer('material_count').notNull().default(0),       // # material variance lines at review time
  unfavorableTotal: numeric('unfavorable_total', { precision: 18, scale: 4 }).notNull().default('0'),
  notes: text('notes'),                        // management's review conclusion + variance follow-up
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byPeriod: index('idx_budget_review_period').on(t.tenantId, t.fiscalYear, t.period) }));

export type BudgetReview = typeof budgetReviews.$inferSelect;

// ── FIN-3 (BUD-02, migration 0296) — budgetary control / encumbrance on procurement ──────────────────────
// Per-tenant budget-control policy for the PR/PO approval gate. One row per tenant (NULL tenant =
// single-company default), mirroring receiving_settings. policy: 'off' (default — report-only, exactly the
// pre-FIN-3 behaviour) | 'advise' (approve + annotate) | 'warn' (approver must confirm the overage) |
// 'block' (reject BUDGET_EXCEEDED unless an exec override with a reason). default_expense_account is the
// budget account used for a PO/PR line whose item carries no cogs_account (item → its category → this).
export const budgetControlSettings = pgTable('budget_control_settings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  policy: text('policy').notNull().default('off'),                       // off | advise | warn | block
  defaultExpenseAccount: text('default_expense_account').notNull().default('5000'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byTenant: index('idx_budget_ctrl_settings_tenant').on(t.tenantId) }));

// GL-budget commitment / encumbrance ledger for NON-project procurement (the project/BoQ twin is
// project_commitments). One row per (approved doc × budget account): a PR approval reserves its estimated
// spend, a PO approval reserves the ordered amount (the PR's reservation is released when it converts to
// POs). 'open' rows count against availability (= approved budget − GL actuals − open commitments);
// 'consumed' (fully received — the spend is now in the GL) and 'released' (cancelled / closed-short /
// converted) do not. An authorised over-budget approval is audited on the row (over_budget +
// override_by/override_reason — BUD-02 evidence).
export const budgetCommitments = pgTable('budget_commitments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  fiscalYear: integer('fiscal_year').notNull(),
  period: text('period').notNull(),                 // YYYY-MM — the approval business month (Asia/Bangkok)
  accountCode: text('account_code').notNull(),
  costCenterCode: text('cost_center_code'),         // null = tenant-wide budget line
  sourceDocType: text('source_doc_type').notNull(), // PR | PO
  sourceDocNo: text('source_doc_no').notNull(),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull().default('0'),
  status: text('status').notNull().default('open'), // open | consumed | released
  overBudget: boolean('over_budget').notNull().default(false),
  overrideBy: text('override_by'),                  // exec who authorised an over-budget approval (block policy)
  overrideReason: text('override_reason'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byAccount: index('idx_budget_commit_account').on(t.tenantId, t.accountCode, t.period),
  bySource: index('idx_budget_commit_source').on(t.sourceDocType, t.sourceDocNo),
}));

export type BudgetControlSettings = typeof budgetControlSettings.$inferSelect;
export type BudgetCommitment = typeof budgetCommitments.$inferSelect;

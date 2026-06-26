// Accounting Tier 3 — Budget vs Actual (งบประมาณเทียบจริง). Reference data only — NOT journal entries.
// One row per account per period (YYYY-MM), optionally per cost center. tenant_id → RLS. No GL effect.
import { pgTable, bigserial, bigint, text, numeric, timestamp, integer, index } from 'drizzle-orm/pg-core';
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

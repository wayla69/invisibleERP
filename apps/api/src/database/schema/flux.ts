// CLS-01 (GL-25) — Flux / variance analysis with forced explanation + sign-off. A SOX management-review
// control over the period close: a preparer GENERATES a period-over-period (or vs prior-year / vs budget)
// P&L or BS movement analysis from gl_period_balances; each line's Δ$ / Δ% is tested against configurable
// thresholds. A threshold-BREACHING line REQUIRES a written explanation before the analysis can be signed
// off; an INDEPENDENT reviewer (≠ preparer) certifies. Posts NOTHING to the GL — read-only aggregator over
// the posting snapshot + these two governance tables. Both are tenant-scoped (tenant_id → RLS, leading
// (tenant_id, …) index).
import { pgTable, bigserial, bigint, text, numeric, boolean, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Analysis header — the period, basis (P&L / BS), comparative basis, thresholds and the maker-checker lifecycle.
export const fluxAnalyses = pgTable('flux_analyses', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  period: text('period').notNull(),                          // 'YYYY-MM'
  basis: text('basis').notNull().default('PL'),              // 'PL' | 'BS'
  comparative: text('comparative').notNull().default('prior_period'), // 'prior_period' | 'prior_year' | 'budget'
  comparativePeriod: text('comparative_period'),             // resolved comparative label (YYYY-MM or 'budget')
  thresholdAbs: numeric('threshold_abs', { precision: 18, scale: 2 }).notNull().default('10000'),
  thresholdPct: numeric('threshold_pct', { precision: 9, scale: 2 }).notNull().default('10'),
  status: text('status').notNull().default('Draft'),         // 'Draft' | 'Explained' | 'Certified'
  breachedCount: integer('breached_count').notNull().default(0),
  explainedCount: integer('explained_count').notNull().default(0),
  preparedBy: text('prepared_by'),
  preparedAt: timestamp('prepared_at', { withTimezone: true }).defaultNow(),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_flux_analyses_tenant').on(t.tenantId, t.period),
}));

// One account movement line per row. `breached` is set at generate; `explanation`/`explained_by` are filled
// by the preparer for every breached line before the analysis can be certified.
export const fluxLines = pgTable('flux_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  analysisId: bigint('analysis_id', { mode: 'number' }).notNull().references(() => fluxAnalyses.id),
  accountCode: text('account_code').notNull(),
  accountName: text('account_name'),
  accountType: text('account_type'),
  currentAmt: numeric('current_amt', { precision: 18, scale: 2 }).notNull().default('0'),
  comparativeAmt: numeric('comparative_amt', { precision: 18, scale: 2 }).notNull().default('0'),
  deltaAmt: numeric('delta_amt', { precision: 18, scale: 2 }).notNull().default('0'),
  deltaPct: numeric('delta_pct', { precision: 9, scale: 2 }),
  breached: boolean('breached').notNull().default(false),
  explanation: text('explanation'),
  explainedBy: text('explained_by'),
  explainedAt: timestamp('explained_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_flux_lines_tenant').on(t.tenantId, t.analysisId),
}));

export type FluxAnalysis = typeof fluxAnalyses.$inferSelect;
export type FluxLine = typeof fluxLines.$inferSelect;

// WS3.2 — Deferred tax (TAX-06) + FX revaluation governance (GL-18). Two period-scoped, idempotent run
// tables (one row per (tenant, period)) wrapping the close numerics in a maker-checker run→post lifecycle:
//   * fxRevalRuns       — period-end revaluation of open foreign-currency AR/AP to the closing rate → 5400.
//   * deferredTaxRuns   — book-vs-tax temporary differences × CIT rate → DTA 1700 / DTL 2700 / expense 5950.
// RLS via the 0168 loop (tenant_id present → tenant_isolation, bypass-aware so an HQ close run can post).
import { pgTable, bigserial, bigint, text, numeric, date, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const fxRevalRuns = pgTable('fx_reval_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  period: text('period').notNull(),                              // 'YYYY-MM'
  asOfDate: date('as_of_date').notNull(),
  status: text('status').notNull().default('Open'),             // 'Open' | 'Posted'
  rates: jsonb('rates'),                                         // {currency: closing rate} actually used
  totalGain: numeric('total_gain', { precision: 18, scale: 4 }).notNull().default('0'),
  totalLoss: numeric('total_loss', { precision: 18, scale: 4 }).notNull().default('0'),
  net: numeric('net', { precision: 18, scale: 4 }).notNull().default('0'),  // +ve gain, -ve loss (P&L sign)
  postedEntryId: bigint('posted_entry_id', { mode: 'number' }),
  detail: jsonb('detail'),                                       // [{scope, currency, open_foreign, booked_rate, closing_rate, delta}]
  runBy: text('run_by'),
  postedBy: text('posted_by'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqPeriod: uniqueIndex('uq_fx_reval_runs_period').on(t.tenantId, t.period) }));

export const deferredTaxRuns = pgTable('deferred_tax_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  period: text('period').notNull(),                             // 'YYYY-MM'
  asOfDate: date('as_of_date').notNull(),
  taxRate: numeric('tax_rate', { precision: 9, scale: 6 }).notNull().default('0.20'),  // Thai CIT 20%
  tempDifferences: jsonb('temp_differences'),                   // [{name, bookBasis, taxBasis, difference, dtAssetOrLiab}]
  dta: numeric('dta', { precision: 18, scale: 4 }).notNull().default('0'),  // deferred tax ASSET
  dtl: numeric('dtl', { precision: 18, scale: 4 }).notNull().default('0'),  // deferred tax LIABILITY
  netDeferred: numeric('net_deferred', { precision: 18, scale: 4 }).notNull().default('0'),  // dta − dtl
  deltaPosted: numeric('delta_posted', { precision: 18, scale: 4 }).notNull().default('0'),  // Δ vs prior posted run
  status: text('status').notNull().default('Open'),            // 'Open' | 'Posted'
  postedEntryId: bigint('posted_entry_id', { mode: 'number' }),
  runBy: text('run_by'),
  postedBy: text('posted_by'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqPeriod: uniqueIndex('uq_deferred_tax_runs_period').on(t.tenantId, t.period) }));

export type FxRevalRun = typeof fxRevalRuns.$inferSelect;
export type DeferredTaxRun = typeof deferredTaxRuns.$inferSelect;

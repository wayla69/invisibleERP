// TAX-11 — Current income-tax provision + ETR reconciliation (ASC 740 / IAS 12, current side). One
// idempotent row per (tenant, period) wrapping the current-tax numerics in a maker-checker run→post
// lifecycle. The DEFERRED side lives in deferred_tax_runs (TAX-06); this table LINKS to it (deferredTaxLink)
// rather than recomputing temporary differences. RLS via the canonical 0232-form tenant_isolation loop
// (tenant_id present → the migration's DO-loop enables it, bypass-aware so an HQ close run can post).
import { pgTable, bigserial, bigint, text, numeric, date, integer, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const incomeTaxProvisions = pgTable('income_tax_provisions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  period: text('period').notNull(),                                        // 'YYYY-MM' — the close/reporting period; keys the deferred-tax link
  fiscalYear: integer('fiscal_year'),                                      // optional FY label
  fromDate: date('from_date').notNull(),                                   // P&L window start
  toDate: date('to_date').notNull(),                                       // P&L window end (income-statement basis for pretax book income)
  pretaxBookIncome: numeric('pretax_book_income', { precision: 18, scale: 4 }).notNull().default('0'),
  permanentDiffs: jsonb('permanent_diffs'),                               // [{name, amount}] — book→tax add(+)/deduct(−)
  temporaryDiffs: jsonb('temporary_diffs'),                               // reused from the deferred-tax run (detail echo)
  permanentAdjTotal: numeric('permanent_adj_total', { precision: 18, scale: 4 }).notNull().default('0'),
  temporaryAdjTotal: numeric('temporary_adj_total', { precision: 18, scale: 4 }).notNull().default('0'),
  taxableIncome: numeric('taxable_income', { precision: 18, scale: 4 }).notNull().default('0'),
  statutoryRate: numeric('statutory_rate', { precision: 9, scale: 6 }).notNull().default('0.20'),  // Thai CIT 20%
  currentTax: numeric('current_tax', { precision: 18, scale: 4 }).notNull().default('0'),          // CIT payable this period
  valuationAllowance: numeric('valuation_allowance', { precision: 18, scale: 4 }).notNull().default('0'),
  rateChangeEffect: numeric('rate_change_effect', { precision: 18, scale: 4 }).notNull().default('0'),
  otherAdjustments: numeric('other_adjustments', { precision: 18, scale: 4 }).notNull().default('0'),
  deferredTaxLink: jsonb('deferred_tax_link'),                            // {run_id, period, net_deferred, delta, deferred_tax_expense, tax_rate}
  totalProvision: numeric('total_provision', { precision: 18, scale: 4 }).notNull().default('0'),  // current + deferred + VA + rate-change + other (total income-tax expense)
  effectiveRate: numeric('effective_rate', { precision: 9, scale: 6 }).notNull().default('0'),      // totalProvision / pretax
  etrLines: jsonb('etr_lines'),                                           // [{key, label, base, rate, tax_effect, pct}]
  status: text('status').notNull().default('Open'),                      // 'Open' | 'Posted'
  postedEntryId: text('posted_entry_id'),                                // journal entry_no of the provision JE (Dr 5960 / Cr 2110)
  runBy: text('run_by'),
  postedBy: text('posted_by'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqPeriod: uniqueIndex('uq_income_tax_provisions_period').on(t.tenantId, t.period) }));

export type IncomeTaxProvision = typeof incomeTaxProvisions.$inferSelect;

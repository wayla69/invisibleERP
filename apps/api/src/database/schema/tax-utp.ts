// TAX-12 — ASC 740 income-tax disclosures that ride ON TOP of the deferred-tax engine (TAX-06):
//   * dtaValuationAllowances — a more-likely-than-not (MLTN) recoverability assessment on the GROSS deferred
//     tax asset. allowance = max(0, dta_gross − mltn_recoverable). A maker-checker run→post lifecycle: the
//     computed 'Open' row is posted (poster ≠ runner) as the DELTA vs the prior posted allowance to the
//     contra-DTA / deferred-tax-expense accounts (1700/5950), so the net DTA carried on the balance sheet is
//     the recoverable portion (TAS 12.24 / ASC 740-10-30-5(e)).
//   * uncertainTaxPositions — a FIN 48 (ASC 740-10) register: position, tax year, gross exposure, the
//     recognized (MLTN-sustainable) benefit, the unrecognized reserve, and any interest/penalty accrual. A
//     memo register (no GL leg — the reserve is a disclosure, not a posting) with maker-checker on
//     create/settle (settler ≠ creator). Status Open | Settled | Lapsed.
// Both tables are tenant-scoped: a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation
// RLS policy (re-applied by the migration's generic DO-loop) + app_user grants.
import { pgTable, bigserial, bigint, integer, text, numeric, date, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const dtaValuationAllowances = pgTable('dta_valuation_allowances', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  period: text('period').notNull(),                                                 // 'YYYY-MM'
  asOfDate: date('as_of_date').notNull(),
  dtaGross: numeric('dta_gross', { precision: 18, scale: 4 }).notNull().default('0'),          // gross DTA (from TAX-06 deferred_tax_runs, or supplied)
  mltnRecoverable: numeric('mltn_recoverable', { precision: 18, scale: 4 }).notNull().default('0'), // MLTN-recoverable portion (management judgment)
  allowance: numeric('allowance', { precision: 18, scale: 4 }).notNull().default('0'),         // max(0, dta_gross − mltn_recoverable)
  deltaPosted: numeric('delta_posted', { precision: 18, scale: 4 }).notNull().default('0'),    // Δ vs the prior posted allowance
  status: text('status').notNull().default('Open'),                                 // 'Open' | 'Posted'
  postedEntryId: bigint('posted_entry_id', { mode: 'number' }),
  basis: text('basis'),                                                             // MLTN assessment rationale (optional)
  runBy: text('run_by'),
  postedBy: text('posted_by'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqPeriod: uniqueIndex('uq_dta_va_period').on(t.tenantId, t.period),
  idxTenant: index('idx_dta_va_tenant').on(t.tenantId, t.status),
}));

export const uncertainTaxPositions = pgTable('uncertain_tax_positions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  positionNo: text('position_no').notNull(),                                        // UTP-YYYYMMDD-NNN
  taxYear: integer('tax_year').notNull(),
  description: text('description').notNull(),
  grossExposure: numeric('gross_exposure', { precision: 18, scale: 4 }).notNull().default('0'),      // total tax at risk
  recognizedBenefit: numeric('recognized_benefit', { precision: 18, scale: 4 }).notNull().default('0'), // MLTN-sustainable benefit recognized
  reserve: numeric('reserve', { precision: 18, scale: 4 }).notNull().default('0'),  // unrecognized tax benefit (gross_exposure − recognized_benefit)
  interestPenalty: numeric('interest_penalty', { precision: 18, scale: 4 }).notNull().default('0'),  // accrued interest + penalty on the position
  status: text('status').notNull().default('Open'),                                 // 'Open' | 'Settled' | 'Lapsed'
  settlementAmount: numeric('settlement_amount', { precision: 18, scale: 4 }),       // amount actually settled with the authority
  settlementNote: text('settlement_note'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  settledBy: text('settled_by'),
  settledAt: timestamp('settled_at', { withTimezone: true }),
}, (t) => ({
  uqNo: uniqueIndex('uq_utp_no').on(t.tenantId, t.positionNo),
  idxTenant: index('idx_utp_tenant').on(t.tenantId, t.status),
}));

export type DtaValuationAllowance = typeof dtaValuationAllowances.$inferSelect;
export type UncertainTaxPosition = typeof uncertainTaxPositions.$inferSelect;

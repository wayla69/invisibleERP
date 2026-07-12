import { pgTable, bigserial, bigint, text, numeric, date, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Debt & Borrowings register (Track C Wave 1) — controls TRE-01 (facility/drawdown maker-checker + idempotent
// EIR amortized-cost accrual) and TRE-02 (covenant-breach monitor). A facility is a credit line; a drawdown
// takes principal off it (Dr 1010 Bank / Cr 2500 short-term or 2550 long-term Borrowings). Each drawdown
// carries an amortized-cost carrying amount (= its outstanding principal at par) and a periodic-run cursor
// (next_run_date / periods_posted) mirroring the lease engine: each period the effective-interest accrual
// posts interest = carrying × EIR/12 (Dr 5900 Interest Expense / Cr 2450 Accrued Interest Payable). Repayment
// clears principal (Dr 2500/2550) and accrued interest (Dr 2450) against cash (Cr 1010). ALL tenant-scoped
// with a leading (tenant_id, …) index + the canonical 0232-form RLS policy (applied by the migration DO-loop).

export const debtFacilities = pgTable(
  'debt_facilities',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    facilityNo: text('facility_no').notNull().unique(),          // DBTF-YYYYMMDD-NNN
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    name: text('name').notNull(),
    lender: text('lender'),
    currency: text('currency').notNull().default('THB'),
    facilityType: text('facility_type').notNull().default('long_term'), // 'short_term' (→2500) | 'long_term' (→2550)
    limitAmount: numeric('limit_amount', { precision: 18, scale: 2 }).notNull().default('0'),
    eirPct: numeric('eir_pct', { precision: 9, scale: 6 }).notNull().default('0'), // effective annual interest rate %
    startDate: date('start_date'),
    maturityDate: date('maturity_date'),
    status: text('status').notNull().default('PendingApproval'),  // PendingApproval | Approved | Rejected | Closed
    drawnAmount: numeric('drawn_amount', { precision: 18, scale: 2 }).notNull().default('0'),          // cumulative principal drawn
    outstandingPrincipal: numeric('outstanding_principal', { precision: 18, scale: 2 }).notNull().default('0'), // running unpaid principal
    requestedBy: text('requested_by'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_debt_facilities_tenant').on(t.tenantId, t.status) }),
);

export const debtDrawdowns = pgTable(
  'debt_drawdowns',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    drawdownNo: text('drawdown_no').notNull().unique(),          // DBTD-YYYYMMDD-NNN
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    facilityId: bigint('facility_id', { mode: 'number' }).references(() => debtFacilities.id),
    drawdownDate: date('drawdown_date'),
    principal: numeric('principal', { precision: 18, scale: 2 }).notNull().default('0'),
    ratePct: numeric('rate_pct', { precision: 9, scale: 6 }).notNull().default('0'),   // EIR at drawdown (defaults to the facility rate)
    amortizedCost: numeric('amortized_cost', { precision: 18, scale: 2 }).notNull().default('0'), // carrying amount (= outstanding principal at par)
    accruedInterest: numeric('accrued_interest', { precision: 18, scale: 2 }).notNull().default('0'), // accrued-but-unpaid interest
    periodsPosted: integer('periods_posted').notNull().default(0),
    nextRunDate: date('next_run_date'),
    status: text('status').notNull().default('active'),          // active | repaid
    entryNo: text('entry_no'),                                    // drawdown JE entry_no
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_debt_drawdowns_tenant').on(t.tenantId, t.facilityId, t.status) }),
);

export const debtCovenants = pgTable(
  'debt_covenants',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    covenantNo: text('covenant_no').notNull().unique(),         // DBTV-YYYYMMDD-NNN
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    facilityId: bigint('facility_id', { mode: 'number' }).references(() => debtFacilities.id),
    name: text('name').notNull(),
    metric: text('metric').notNull(),                            // e.g. 'DSCR' | 'current_ratio' | 'debt_to_equity' | 'leverage'
    operator: text('operator').notNull().default('gte'),        // gte | lte | gt | lt — the direction that PASSES
    threshold: numeric('threshold', { precision: 18, scale: 6 }).notNull().default('0'),
    cadence: text('cadence').notNull().default('quarterly'),    // monthly | quarterly | annual
    status: text('status').notNull().default('active'),         // active | waived
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_debt_covenants_tenant').on(t.tenantId, t.facilityId, t.status) }),
);

export const debtCovenantTests = pgTable(
  'debt_covenant_tests',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    covenantId: bigint('covenant_id', { mode: 'number' }).references(() => debtCovenants.id),
    facilityId: bigint('facility_id', { mode: 'number' }).references(() => debtFacilities.id),
    asOf: date('as_of'),
    metric: text('metric'),
    operator: text('operator'),
    threshold: numeric('threshold', { precision: 18, scale: 6 }).notNull().default('0'),
    actualValue: numeric('actual_value', { precision: 18, scale: 6 }).notNull().default('0'),
    breached: boolean('breached').notNull().default(false),
    note: text('note'),
    testedBy: text('tested_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_debt_covenant_tests_tenant').on(t.tenantId, t.covenantId, t.breached) }),
);

export type DebtFacility = typeof debtFacilities.$inferSelect;
export type DebtDrawdown = typeof debtDrawdowns.$inferSelect;
export type DebtCovenant = typeof debtCovenants.$inferSelect;
export type DebtCovenantTest = typeof debtCovenantTests.$inferSelect;

import { pgTable, bigserial, bigint, text, numeric, date, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Lessor-side lease accounting (IFRS 16 / TFRS 16 lessor) — control LSE-02. A lease is classified at
// commencement as a FINANCE lease or an OPERATING lease per the IFRS 16 lessor criteria (transfer of
// ownership / bargain purchase / lease term is a major part of the asset's economic life / PV of the
// payments ≈ fair value). Classification + commencement is maker-checker: the row is created 'pending'
// and a DIFFERENT user approves it (SoD) before any GL is booked.
//   FINANCE lease: at commencement the lessor DERECOGNISES the underlying asset (Cr 1500) and recognises a
//   NET INVESTMENT IN LEASE / lease receivable at the PV of the payments (Dr 1610), any selling profit/loss
//   to 1510. Each period the scheduled run recognises INTEREST INCOME (Cr 4600) on the running receivable
//   and collects the cash (Dr 1000), reducing the receivable by the principal portion.
//   OPERATING lease: the lessor KEEPS the asset, recognises STRAIGHT-LINE RENTAL INCOME (Dr 1000 / Cr 4610)
//   and CONTINUES DEPRECIATING the asset (Dr 5200 / Cr 1590) over its economic life.
export const lessorLeases = pgTable(
  'lessor_leases',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    leaseNo: text('lease_no').notNull().unique(), // LSR-YYYYMMDD-NNN
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    name: text('name').notNull(),
    lessee: text('lessee'),
    startDate: date('start_date'),
    termMonths: bigint('term_months', { mode: 'number' }).notNull(),
    monthlyPayment: numeric('monthly_payment', { precision: 14, scale: 2 }).notNull(),
    annualRatePct: numeric('annual_rate_pct', { precision: 8, scale: 4 }).notNull().default('0'), // interest rate implicit in the lease
    // classification inputs (IFRS 16 lessor criteria)
    assetCost: numeric('asset_cost', { precision: 14, scale: 2 }).notNull().default('0'),      // underlying asset carrying amount at commencement
    fairValue: numeric('fair_value', { precision: 14, scale: 2 }).default('0'),                // fair value of the underlying asset (PV≈FV test)
    economicLifeMonths: bigint('economic_life_months', { mode: 'number' }),                    // asset's economic life (major-part-of-life test)
    transferOwnership: boolean('transfer_ownership').notNull().default(false),
    bargainPurchase: boolean('bargain_purchase').notNull().default(false),
    classification: text('classification').notNull(), // finance | operating
    // finance-lease running figures
    netInvestment: numeric('net_investment', { precision: 14, scale: 2 }).default('0'),        // = PV of payments at commencement
    receivableBalance: numeric('receivable_balance', { precision: 14, scale: 2 }).default('0'),// running net investment / lease receivable (1610)
    interestIncomeRecognized: numeric('interest_income_recognized', { precision: 14, scale: 2 }).default('0'),
    // operating-lease running figures
    accumulatedDep: numeric('accumulated_dep', { precision: 14, scale: 2 }).default('0'),      // running asset depreciation (1590)
    rentalIncomeRecognized: numeric('rental_income_recognized', { precision: 14, scale: 2 }).default('0'),
    periodsPosted: bigint('periods_posted', { mode: 'number' }).default(0),
    nextRunDate: date('next_run_date'),
    status: text('status').notNull().default('pending'), // pending (awaiting classification approval) | active | complete
    createdBy: text('created_by'),
    approvedBy: text('approved_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    byDue: index('idx_lessor_lease_due').on(t.status, t.nextRunDate),
    // tenant-leading index — required by the cutover/tenant-idx gate (R1-1 / AUD-ARC-01), migration 0318
    byTenant: index('idx_lessor_leases_tenant').on(t.tenantId, t.status),
  }),
);

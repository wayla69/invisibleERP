import { pgTable, bigserial, bigint, text, numeric, date, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Lease accounting (IFRS 16 / TFRS 16) — control LSE-01. At commencement a right-of-use asset and a lease
// liability are recognised at the present value of the lease payments (Dr 1600 / Cr 2600, non-cash). Each
// period the scheduled run posts: interest unwinding on the liability (Dr 5900), the cash payment reducing
// the liability (Dr 2600 / Cr 1000), and straight-line ROU depreciation (Dr 5210 / Cr 1690).
export const leases = pgTable(
  'leases',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    leaseNo: text('lease_no').notNull().unique(), // LSE-YYYYMMDD-NNN
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    name: text('name').notNull(),
    lessor: text('lessor'),
    startDate: date('start_date'),
    termMonths: bigint('term_months', { mode: 'number' }).notNull(),
    monthlyPayment: numeric('monthly_payment', { precision: 14, scale: 2 }).notNull(),
    annualRatePct: numeric('annual_rate_pct', { precision: 8, scale: 4 }).notNull().default('0'), // incremental borrowing rate
    initialLiability: numeric('initial_liability', { precision: 14, scale: 2 }).default('0'),    // = ROU at commencement
    liabilityBalance: numeric('liability_balance', { precision: 14, scale: 2 }).default('0'),     // running
    accumulatedDep: numeric('accumulated_dep', { precision: 14, scale: 2 }).default('0'),         // running ROU depreciation
    periodsPosted: bigint('periods_posted', { mode: 'number' }).default(0),
    nextRunDate: date('next_run_date'),
    status: text('status').notNull().default('active'), // active | complete
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byDue: index('idx_lease_due').on(t.status, t.nextRunDate) }),
);

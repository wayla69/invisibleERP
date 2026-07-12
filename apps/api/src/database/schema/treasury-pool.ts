import { pgTable, bigserial, bigint, text, numeric, date, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Cash pooling / in-house bank / intercompany-loan register (Track C Wave 4 — control TRE-05). Three surfaces
// on one spine:
//   • CASH POOL (notional | physical) — a header (master) account with member sub-accounts (the in-house-bank
//     model). A PHYSICAL pool SWEEPS cash from a member account to the header (Dr header-bank / Cr member-bank);
//     a NOTIONAL pool never moves cash but ALLOCATES the pooled interest benefit/cost across members, an
//     allocation that MUST sum to zero (a pure internal redistribution — surplus members earn 4700 interest
//     income, deficit members bear 5900 interest expense; net group P&L = 0). The zero-sum IS the control.
//   • IC LOAN register — a real intercompany loan under maker-checker (register → PendingApproval; a DIFFERENT
//     user approves → the mirrored drawdown posts Dr 1155 IC-Loan-Receivable (creditor) / Cr 1010 Bank AND
//     Dr 1010 Bank / Cr 2155 IC-Loan-Payable (debtor); self-approve → 403 SOD_SELF_APPROVAL). Interest accrues
//     on the effective-interest (EIR) amortized-cost carrying (reusing the Wave-1 periodic cursor +
//     alreadyPosted idempotency): creditor Dr 1155 / Cr 4700 Investment/Interest Income, debtor Dr 5900 Interest
//     Expense / Cr 2155. THE CONTROL CORE: on consolidation the 1155/2155 pair AND the 4700/5900 IC interest
//     ELIMINATE so group balances and group finance cost/income net to zero (mirroring the 1150/2150 pair).
// The IC-loan row's tenant_id = the CREDITOR side (mirrors ic_transactions scoping → the creditor is the RLS
// owner). ALL tables tenant-scoped with a leading (tenant_id, …) index + the canonical 0232-form RLS policy.

export const cashPools = pgTable(
  'cash_pools',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    poolNo: text('pool_no').notNull().unique(),                     // POOL-YYYYMMDD-NNN
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    name: text('name').notNull(),
    poolType: text('pool_type').notNull().default('notional'),      // notional | physical
    headerAccount: text('header_account').notNull(),                // the pool header (master) GL bank account
    currency: text('currency').notNull().default('THB'),
    status: text('status').notNull().default('active'),             // active | closed
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_cash_pools_tenant').on(t.tenantId, t.poolType, t.status) }),
);

// Pool members — the sub-accounts feeding a header account. `cap` bounds a member's participation (e.g. a
// max sweepable/notional balance). `member_tenant_id` records which company the sub-account belongs to.
export const cashPoolMembers = pgTable(
  'cash_pool_members',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    poolId: bigint('pool_id', { mode: 'number' }).references(() => cashPools.id),
    memberTenantId: bigint('member_tenant_id', { mode: 'number' }).references(() => tenants.id),
    memberAccount: text('member_account').notNull(),               // the member sub-account GL bank account
    cap: numeric('cap', { precision: 18, scale: 2 }).notNull().default('0'), // participation cap (0 = uncapped)
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_cash_pool_members_tenant').on(t.tenantId, t.poolId) }),
);

// Intercompany loan register — creditor lends to debtor. tenant_id = creditorTenantId (RLS owner).
export const icLoans = pgTable(
  'ic_loans',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    loanNo: text('loan_no').notNull().unique(),                     // ICLN-YYYYMMDD-NNN
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // = creditorTenantId (RLS owner)
    creditorTenantId: bigint('creditor_tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
    debtorTenantId: bigint('debtor_tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
    principal: numeric('principal', { precision: 18, scale: 2 }).notNull().default('0'),
    eirPct: numeric('eir_pct', { precision: 9, scale: 6 }).notNull().default('0'), // effective annual interest rate %
    carrying: numeric('carrying', { precision: 18, scale: 2 }).notNull().default('0'), // amortized-cost carrying (receivable)
    accruedInterest: numeric('accrued_interest', { precision: 18, scale: 2 }).notNull().default('0'),
    currency: text('currency').notNull().default('THB'),
    startDate: date('start_date'),
    nextRunDate: date('next_run_date'),                            // EIR accrual cursor
    periodsPosted: integer('periods_posted').notNull().default(0),
    status: text('status').notNull().default('PendingApproval'),   // PendingApproval | Approved | Rejected | Repaid
    creditorEntryNo: text('creditor_entry_no'),                    // drawdown JE (creditor side)
    debtorEntryNo: text('debtor_entry_no'),                        // drawdown JE (debtor side)
    requestedBy: text('requested_by'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_ic_loans_tenant').on(t.tenantId, t.status) }),
);

// IC-loan interest accrual ledger — one row per posted period (idempotent EIR accrual), carrying both mirrored
// journal entry numbers (creditor income 4700, debtor expense 5900).
export const icLoanAccruals = pgTable(
  'ic_loan_accruals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // = creditorTenantId
    loanId: bigint('loan_id', { mode: 'number' }).references(() => icLoans.id),
    asOf: date('as_of'),
    period: text('period'),                                        // 'YYYY-MM'
    interest: numeric('interest', { precision: 18, scale: 2 }).notNull().default('0'),
    creditorEntryNo: text('creditor_entry_no'),
    debtorEntryNo: text('debtor_entry_no'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_ic_loan_accruals_tenant').on(t.tenantId, t.loanId, t.asOf) }),
);

export type CashPool = typeof cashPools.$inferSelect;
export type CashPoolMember = typeof cashPoolMembers.$inferSelect;
export type IcLoan = typeof icLoans.$inferSelect;
export type IcLoanAccrual = typeof icLoanAccruals.$inferSelect;

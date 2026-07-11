import { pgTable, bigserial, bigint, text, numeric, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── HR-2 (docs/42) — Leave accrual engine + policies ──────────────────────────
// Turns the static leave_balances (entitled/used) into a real accrual model: a leave TYPE carries its
// accrual method + caps, a POLICY overrides the type rate by job-grade/tenure, and an idempotent monthly
// accrual run (rides the BI scheduler like gl_recurring_journals) credits `accrued` on each balance.
// Control HR-02: a leave request beyond the available balance (entitled+accrued+carryover−used) is blocked.

// Leave type master — the accrual policy backbone (per tenant). code e.g. ANNUAL / SICK / PERSONAL.
export const leaveTypes = pgTable(
  'leave_types',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    code: text('code').notNull(),                                  // ANNUAL | SICK | PERSONAL | UNPAID …
    name: text('name').notNull(),
    accrualMethod: text('accrual_method').notNull().default('none'), // monthly | anniversary | none
    accrualRateDays: numeric('accrual_rate_days', { precision: 8, scale: 4 }).notNull().default('0'), // days per period
    carryoverCapDays: numeric('carryover_cap_days', { precision: 8, scale: 2 }).notNull().default('0'), // max days rolled to next year
    maxBalanceDays: numeric('max_balance_days', { precision: 8, scale: 2 }).notNull().default('0'),     // hard cap on total balance (0 = uncapped)
    allowNegative: boolean('allow_negative').notNull().default(false), // if true, the entitlement gate is relaxed
    active: boolean('active').notNull().default(true),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_leave_types_tenant').on(t.tenantId, t.code) }),
);

// Policy overrides — a leave type's default accrual rate can be raised by job grade and/or minimum tenure.
export const leavePolicies = pgTable(
  'leave_policies',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    leaveTypeId: bigint('leave_type_id', { mode: 'number' }).notNull().references(() => leaveTypes.id),
    jobGrade: text('job_grade'),                                    // nullable — applies to any grade when null
    minTenureMonths: integer('min_tenure_months').notNull().default(0),
    accrualRateDays: numeric('accrual_rate_days', { precision: 8, scale: 4 }).notNull().default('0'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_leave_policies_tenant').on(t.tenantId, t.leaveTypeId) }),
);

// Accrual-run ledger — one row per (tenant, period) so a re-run of the same YYYY-MM is a no-op (idempotent).
export const leaveAccrualRuns = pgTable(
  'leave_accrual_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    period: text('period').notNull(),                              // YYYY-MM
    runAt: timestamp('run_at', { withTimezone: true }).defaultNow(),
    accruedTotal: numeric('accrued_total', { precision: 12, scale: 2 }).notNull().default('0'),
    employeesCount: integer('employees_count').notNull().default(0),
    runBy: text('run_by'),
  },
  (t) => ({ byTenantPeriod: index('idx_leave_accrual_runs_tenant').on(t.tenantId, t.period) }),
);

export type LeaveType = typeof leaveTypes.$inferSelect;
export type LeavePolicy = typeof leavePolicies.$inferSelect;
export type LeaveAccrualRun = typeof leaveAccrualRuns.$inferSelect;

import { pgTable, bigserial, bigint, text, numeric, date, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { employees } from './payroll';

// ── Attendance / timesheets (ลงเวลา) — feeds overtime into payroll ──
export const timesheets = pgTable(
  'timesheets',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    employeeId: bigint('employee_id', { mode: 'number' }).notNull().references(() => employees.id),
    workDate: date('work_date').notNull(),
    regularHours: numeric('regular_hours', { precision: 6, scale: 2 }).default('0'),
    otHours: numeric('ot_hours', { precision: 6, scale: 2 }).default('0'),
    note: text('note'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byEmp: index('idx_ts_emp').on(t.employeeId), byTenant: index('idx_ts_tenant').on(t.tenantId) }),
);

// ── Leave (การลา) — requests reduce pay when unpaid; balances track entitlement ──
export const leaveRequests = pgTable(
  'leave_requests',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    employeeId: bigint('employee_id', { mode: 'number' }).notNull().references(() => employees.id),
    leaveType: text('leave_type').notNull().default('annual'), // annual | sick | personal | unpaid
    fromDate: date('from_date').notNull(),
    toDate: date('to_date').notNull(),
    days: numeric('days', { precision: 6, scale: 2 }).notNull().default('0'),
    paid: boolean('paid').default(true),
    status: text('status').notNull().default('Pending'),       // Pending | Approved | Rejected
    reason: text('reason'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byEmp: index('idx_lr_emp').on(t.employeeId), byTenant: index('idx_lr_tenant').on(t.tenantId) }),
);

export const leaveBalances = pgTable(
  'leave_balances',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    employeeId: bigint('employee_id', { mode: 'number' }).notNull().references(() => employees.id),
    leaveType: text('leave_type').notNull(),
    year: numeric('year').notNull(),
    entitled: numeric('entitled', { precision: 6, scale: 2 }).default('0'),
    used: numeric('used', { precision: 6, scale: 2 }).default('0'),
  },
  (t) => ({ byEmp: index('idx_lb_emp').on(t.employeeId) }),
);

export type Timesheet = typeof timesheets.$inferSelect;

// ── Expense claims (เบิกค่าใช้จ่าย) — ESS reimbursement: employee submits, manager approves → GL (Phase D3) ──
export const expenseClaims = pgTable(
  'expense_claims',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    employeeId: bigint('employee_id', { mode: 'number' }).references(() => employees.id),
    claimDate: date('claim_date'),
    category: text('category'),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull().default('0'),
    description: text('description'),
    status: text('status').notNull().default('Pending'), // Pending | Approved | Rejected
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    entryNo: text('entry_no'),                           // GL JE on approval (Dr 5100 / Cr 2000)
    apTxnNo: text('ap_txn_no'),                          // AP reimbursement payable raised on approval (AP-…)
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byEmp: index('idx_expense_claims_emp2').on(t.employeeId) }),
);

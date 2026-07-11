import { pgTable, bigserial, bigint, text, numeric, date, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { encryptedText } from '../encrypted-column';
import { tenants } from './tenants';

// Employees (พนักงาน) — tenant-scoped (RLS via tenant_id). Salary drives payroll.
export const employees = pgTable(
  'employees',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    empCode: text('emp_code').notNull(),
    name: text('name').notNull(),
    // PII-at-rest (ITGC-AC-19, docs/27 R0-1): citizen ID / SSO no / bank account are encrypted (AES-256-GCM,
    // legacy-plaintext passthrough). NOT queried by value anywhere — aggregations key on employee_id/emp_code.
    nationalId: encryptedText('national_id'),   // เลขบัตรประชาชน (13 หลัก) — for ภ.ง.ด.1
    ssoNo: encryptedText('sso_no'),             // เลขประกันสังคม
    position: text('position'),
    department: text('department'),
    jobGrade: text('job_grade'),                // HR-2 (docs/42) — drives leave-accrual policy overrides by grade

    monthlySalary: numeric('monthly_salary', { precision: 14, scale: 2 }).notNull().default('0'),
    hourlyRate: numeric('hourly_rate', { precision: 12, scale: 2 }).default('0'),      // for OT pay
    pfRate: numeric('pf_rate', { precision: 6, scale: 4 }).default('0'),               // provident fund % (ee=er)
    allowances: numeric('allowances', { precision: 14, scale: 2 }).default('0'), // extra tax allowances (annual)
    ssoEligible: boolean('sso_eligible').default(true),
    bankAccount: encryptedText('bank_account'), // PII-at-rest (ITGC-AC-19) — decrypts only at the payment boundary
    userName: text('user_name'),                // ESS: link to users.username for self-service (Phase D3)
    startDate: date('start_date'),
    active: boolean('active').default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_emp_tenant').on(t.tenantId) }),
);

// A payroll run for one period (YYYY-MM). Posting creates a balanced GL entry.
export const payruns = pgTable(
  'payruns',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    period: text('period').notNull(),          // 'YYYY-MM'
    status: text('status').notNull().default('Posted'),
    headcount: bigint('headcount', { mode: 'number' }).default(0),
    grossTotal: numeric('gross_total', { precision: 16, scale: 2 }).default('0'),
    ssoEeTotal: numeric('sso_ee_total', { precision: 16, scale: 2 }).default('0'),
    ssoErTotal: numeric('sso_er_total', { precision: 16, scale: 2 }).default('0'),
    whtTotal: numeric('wht_total', { precision: 16, scale: 2 }).default('0'),
    netTotal: numeric('net_total', { precision: 16, scale: 2 }).default('0'),
    entryNo: text('entry_no'),                 // GL JE reference
    runBy: text('run_by'),
    runAt: timestamp('run_at', { withTimezone: true }).defaultNow(),
    approvedBy: text('approved_by'),           // PAY-03 maker-checker: who approved (must differ from runBy)
    approvedAt: timestamp('approved_at', { withTimezone: true }),
  },
  (t) => ({ byTenantPeriod: index('idx_payrun_tenant_period').on(t.tenantId, t.period) }),
);

// Per-employee line of a payrun (the payslip).
export const payslips = pgTable(
  'payslips',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    payrunId: bigint('payrun_id', { mode: 'number' }).notNull().references(() => payruns.id),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    employeeId: bigint('employee_id', { mode: 'number' }).references(() => employees.id),
    empCode: text('emp_code'),
    empName: text('emp_name'),
    // PII-at-rest (ITGC-AC-19): the per-slip citizen-ID snapshot is ciphertext too. Random-IV AES-GCM means
    // ciphertext is NOT groupable in SQL — PND1A aggregates in app code keyed on employee_id/emp_code.
    nationalId: encryptedText('national_id'),
    gross: numeric('gross', { precision: 14, scale: 2 }).default('0'),
    otPay: numeric('ot_pay', { precision: 14, scale: 2 }).default('0'),
    unpaid: numeric('unpaid', { precision: 14, scale: 2 }).default('0'),
    ssoEmployee: numeric('sso_employee', { precision: 14, scale: 2 }).default('0'),
    ssoEmployer: numeric('sso_employer', { precision: 14, scale: 2 }).default('0'),
    pfEmployee: numeric('pf_employee', { precision: 14, scale: 2 }).default('0'),
    pfEmployer: numeric('pf_employer', { precision: 14, scale: 2 }).default('0'),
    wht: numeric('wht', { precision: 14, scale: 2 }).default('0'),
    net: numeric('net', { precision: 14, scale: 2 }).default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byRun: index('idx_payslip_run').on(t.payrunId) }),
);

export type Employee = typeof employees.$inferSelect;

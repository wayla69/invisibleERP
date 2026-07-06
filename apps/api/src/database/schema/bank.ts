import { pgTable, bigserial, bigint, text, numeric, date, timestamp, pgEnum, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Bank reconciliation (การกระทบยอดธนาคาร): per-bank house-bank GL accounts (1010/1020), statement
// import, auto-match statement lines to unreconciled GL cash movements. Every table carries tenant_id (RLS).
export const bankLineKindEnum = pgEnum('bank_line_kind', ['credit', 'debit']);

export const bankAccounts = pgTable('bank_accounts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  bankName: text('bank_name').notNull(),
  accountNo: text('account_no').notNull(),
  glAccountCode: text('gl_account_code').notNull().default('1010'),
  currency: text('currency').default('THB'),
  openingBalance: numeric('opening_balance', { precision: 18, scale: 4 }).notNull().default('0'),
  active: text('active').default('true'),
  // G9 (audit) maker-checker: a new bank account (account no + GL mapping + opening balance) is created
  // 'PendingApproval' and not usable until a DISTINCT approver activates it. Existing rows backfill to
  // 'Approved' (migration 0264 default) so they stay usable.
  status: text('status').notNull().default('Approved'),
  requestedBy: text('requested_by'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqBankAcct: unique('uq_bank_acct').on(t.tenantId, t.accountNo) }));

export const bankStatements = pgTable('bank_statements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  statementNo: text('statement_no').notNull(),
  bankAccountId: bigint('bank_account_id', { mode: 'number' }).notNull().references(() => bankAccounts.id),
  statementDate: date('statement_date').notNull(),
  openingBal: numeric('opening_bal', { precision: 18, scale: 4 }).notNull().default('0'),
  closingBal: numeric('closing_bal', { precision: 18, scale: 4 }).notNull().default('0'),
  lineCount: bigint('line_count', { mode: 'number' }).notNull().default(0),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqStmtNo: unique('uq_bank_stmt_no').on(t.tenantId, t.statementNo), byAcct: index('idx_stmt_acct').on(t.bankAccountId) }));

export const bankStatementLines = pgTable('bank_statement_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  statementId: bigint('statement_id', { mode: 'number' }).notNull().references(() => bankStatements.id),
  bankAccountId: bigint('bank_account_id', { mode: 'number' }).notNull().references(() => bankAccounts.id),
  lineDate: date('line_date').notNull(),
  description: text('description'),
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(), // SIGNED: +in (deposit), -out (withdrawal/fee)
  runningBalance: numeric('running_balance', { precision: 18, scale: 4 }),
  reconciled: text('reconciled').notNull().default('false'),
  matchedJournalLineId: bigint('matched_journal_line_id', { mode: 'number' }),
  matchedPaymentNo: text('matched_payment_no'),
  adjustmentJournalNo: text('adjustment_journal_no'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byStmt: index('idx_stmt_line_stmt').on(t.statementId), byAcct2: index('idx_stmt_line_acct').on(t.bankAccountId), byRecon: index('idx_stmt_line_recon').on(t.reconciled) }));

export type BankAccount = typeof bankAccounts.$inferSelect;
export type BankStatement = typeof bankStatements.$inferSelect;
export type BankStatementLine = typeof bankStatementLines.$inferSelect;

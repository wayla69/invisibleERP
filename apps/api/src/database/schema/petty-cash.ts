// Petty cash imprest float + direct-expense / advance maker-checker with document tracking (EXP-08).
// A fund holds an imprest float capped at a credit limit (วงเงิน); requests draw against it as a direct
// expense or an advance, posting to the GL only on independent approval. Both tables are tenant-scoped
// (RLS via the 0139 loop). GL effects via LedgerService.postEntry.
import { pgTable, bigserial, bigint, text, numeric, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const pettyCashFunds = pgTable('petty_cash_funds', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  fundCode: text('fund_code').notNull(),
  name: text('name'),
  custodian: text('custodian'),
  department: text('department'),
  glAccount: text('gl_account').notNull().default('1015'), // petty-cash control account
  floatLimit: numeric('float_limit', { precision: 14, scale: 2 }).notNull().default('0'), // วงเงิน — imprest ceiling
  balance: numeric('balance', { precision: 14, scale: 2 }).notNull().default('0'),         // cash on hand
  status: text('status').notNull().default('active'), // active | closed
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqFund: unique('uq_petty_fund_code').on(t.tenantId, t.fundCode) }));

export const expenseRequests = pgTable('expense_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  reqNo: text('req_no').notNull(),                    // PEX-YYYYMMDD-NNN
  fundId: bigint('fund_id', { mode: 'number' }).references(() => pettyCashFunds.id),
  kind: text('kind').notNull(),                       // expense | advance
  payee: text('payee'),
  purpose: text('purpose'),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  projectId: bigint('project_id', { mode: 'number' }), // M4 (docs/32) — petty-cash expense/advance against a project (nullable)
  expenseAccount: text('expense_account').notNull().default('5100'),
  docRef: text('doc_ref'),                            // external document/receipt no (document tracking)
  receiptKey: text('receipt_key'),                    // uploaded receipt image key
  status: text('status').notNull().default('PendingApproval'), // PendingApproval | Approved | Rejected | Settled
  requestedBy: text('requested_by'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),                    // checker — must differ from requestedBy
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
  settledExpense: numeric('settled_expense', { precision: 14, scale: 2 }),
  returnedCash: numeric('returned_cash', { precision: 14, scale: 2 }),
  settledBy: text('settled_by'),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  glRef: text('gl_ref'),
}, (t) => ({ uqReq: unique('uq_expense_req_no').on(t.tenantId, t.reqNo), byStatus: index('idx_expense_req_status').on(t.tenantId, t.status), byFund: index('idx_expense_req_fund').on(t.fundId) }));

export type PettyCashFund = typeof pettyCashFunds.$inferSelect;
export type ExpenseRequest = typeof expenseRequests.$inferSelect;

import { pgTable, bigserial, bigint, text, numeric, date, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { bankAccounts } from './bank';

// POS-8 / control POS-08 — PromptPay store-level auto-reconciliation. Match PromptPay-tendered sales
// against imported bank-statement inflows on the store's settlement account (reusing the bank auto-match
// engine), surfacing unmatched tenders as a till/cash exception. Both tables carry tenant_id (RLS, 0232).

// The house-bank account a store's PromptPay QR collections settle into (one settlement account per store).
export const posSettlementAccounts = pgTable('pos_settlement_accounts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  bankAccountId: bigint('bank_account_id', { mode: 'number' }).notNull().references(() => bankAccounts.id),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqTenant: unique('uq_pos_settlement_tenant').on(t.tenantId), byTenant: index('idx_pos_settlement_tenant').on(t.tenantId) }));

// A PromptPay tender with no matching bank inflow — a till/cash exception (mirrors the till-variance
// exception surface): Open until a manager clears it (Resolved).
export const promptpayTillExceptions = pgTable('promptpay_till_exceptions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  reconDate: date('recon_date').notNull(),
  paymentNo: text('payment_no').notNull(),
  tillSessionId: bigint('till_session_id', { mode: 'number' }),
  bankAccountId: bigint('bank_account_id', { mode: 'number' }).references(() => bankAccounts.id),
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
  gatewayRef: text('gateway_ref'),
  status: text('status').notNull().default('Open'),        // Open | Resolved
  note: text('note'),
  resolvedBy: text('resolved_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqExc: unique('uq_promptpay_exc').on(t.tenantId, t.paymentNo),
  byDate: index('idx_promptpay_exc_tenant').on(t.tenantId, t.reconDate),
  byStatus: index('idx_promptpay_exc_status').on(t.tenantId, t.status),
}));

export type PosSettlementAccount = typeof posSettlementAccounts.$inferSelect;
export type PromptpayTillException = typeof promptpayTillExceptions.$inferSelect;

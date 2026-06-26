import { pgTable, bigserial, bigint, text, numeric, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Cash drawer movements on an open till (paid-in / paid-out / cash-drop). POS Tier 1 #3.
export const cashMovementTypeEnum = pgEnum('cash_movement_type', ['paid_in', 'paid_out', 'drop']);

export const cashMovements = pgTable('cash_movements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  movementNo: text('movement_no').notNull().unique(),       // CASHMOV-YYYYMMDD-NNN
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  tillSessionId: bigint('till_session_id', { mode: 'number' }).notNull(),
  type: cashMovementTypeEnum('type').notNull(),
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
  reason: text('reason'),
  journalNo: text('journal_no'),                            // GL ref for paid_in/paid_out (null for drop)
  depositId: bigint('deposit_id', { mode: 'number' }),      // REC-05: the bank_deposit a 'drop' was banked into (null = still in the safe)
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// REC-05 — bank deposits. Cash dropped from tills into the safe is batched into a bank deposit and posted
// to GL (Dr bank account / Cr 1000 Cash), then reconciled to the bank statement. Undeposited drops (a 'drop'
// with deposit_id NULL) are cash still sitting in the safe — a detective control surfaces that exposure.
export const bankDeposits = pgTable('bank_deposits', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  depositNo: text('deposit_no').notNull(),                  // BDEP-YYYYMMDD-NNN
  bankAccountId: bigint('bank_account_id', { mode: 'number' }).notNull(),
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
  status: text('status').notNull().default('Deposited'),    // Deposited | Reconciled
  depositDate: text('deposit_date'),                        // YYYY-MM-DD
  journalNo: text('journal_no'),
  reconciledBy: text('reconciled_by'),
  reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type CashMovement = typeof cashMovements.$inferSelect;
export type BankDeposit = typeof bankDeposits.$inferSelect;

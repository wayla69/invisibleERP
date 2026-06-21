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
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type CashMovement = typeof cashMovements.$inferSelect;

// Accounting Tier 3 — Revenue Recognition / Deferred Revenue (รายได้รอตัดบัญชี).
// rev_rec_schedules = a prepaid amount deferred to 2400 then recognized straight-line to 4000.
// rev_rec_lines = one row per period (YYYY-MM); recognized flips true when its REVREC JE posts.
// tenant_id → RLS. GL is the source of truth; these tables are the recognition sub-ledger.
import { pgTable, bigserial, bigint, text, numeric, integer, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const revRecSchedules = pgTable('rev_rec_schedules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  scheduleNo: text('schedule_no').notNull().unique(),     // DEFREV-YYYYMMDD-NNN
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  sourceRef: text('source_ref'),
  totalAmount: numeric('total_amount', { precision: 18, scale: 4 }).notNull(),
  startPeriod: text('start_period').notNull(),            // 'YYYY-MM'
  endPeriod: text('end_period').notNull(),                // 'YYYY-MM' (inclusive)
  months: integer('months').notNull(),
  method: text('method').notNull().default('straight_line'),
  deferredAccount: text('deferred_account').notNull().default('2400'),
  revenueAccount: text('revenue_account').notNull().default('4000'),
  currency: text('currency').default('THB'),
  status: text('status').notNull().default('active'),     // 'active' | 'completed'
  deferralJournalNo: text('deferral_journal_no'),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byTenant: index('idx_revrec_sched_tenant').on(t.tenantId) }));

export const revRecLines = pgTable('rev_rec_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  scheduleId: bigint('schedule_id', { mode: 'number' }).notNull().references(() => revRecSchedules.id),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  period: text('period').notNull(),                       // 'YYYY-MM'
  amount: numeric('amount', { precision: 18, scale: 4 }).notNull(),
  recognized: boolean('recognized').notNull().default(false),
  journalNo: text('journal_no'),
}, (t) => ({ bySchedule: index('idx_revrec_line_sched').on(t.scheduleId), uqLine: uniqueIndex('uq_revrec_line').on(t.scheduleId, t.period) }));

export type RevRecSchedule = typeof revRecSchedules.$inferSelect;
export type RevRecLine = typeof revRecLines.$inferSelect;

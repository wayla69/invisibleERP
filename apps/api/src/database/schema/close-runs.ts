import { pgTable, bigserial, bigint, text, boolean, timestamp, jsonb, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// WS2.1 (GL-15/GL-16) — Hard period close + close checklist.
// A close_runs row per (tenant, period) drives a checklist of close_run_steps; the period can only be
// Locked once all required steps are Done, and the locker must differ from the starter (maker-checker SoD).
export const closeRuns = pgTable('close_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  period: text('period').notNull(),                 // 'YYYY-MM'
  status: text('status').notNull().default('Open'), // 'Open' | 'InProgress' | 'ReadyToLock' | 'Locked'
  startedBy: text('started_by').notNull(),
  lockedBy: text('locked_by'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqRun: uniqueIndex('uq_close_runs').on(t.tenantId, t.period),
}));

export const closeRunSteps = pgTable('close_run_steps', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  closeRunId: bigint('close_run_id', { mode: 'number' }).notNull().references(() => closeRuns.id),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  stepKey: text('step_key').notNull(),              // 'subledger_tieout' | 'bank_rec' | 'depreciation' | 'recurring' | 'fx_reval' | 'trial_balance_review'
  title: text('title').notNull(),
  seq: integer('seq').notNull(),
  required: boolean('required').notNull().default(true),
  status: text('status').notNull().default('Pending'), // 'Pending' | 'Done' | 'Skipped'
  completedBy: text('completed_by'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  detail: jsonb('detail'),
}, (t) => ({
  uqStep: uniqueIndex('uq_close_run_steps').on(t.closeRunId, t.stepKey),
}));

export type CloseRun = typeof closeRuns.$inferSelect;
export type CloseRunStep = typeof closeRunSteps.$inferSelect;

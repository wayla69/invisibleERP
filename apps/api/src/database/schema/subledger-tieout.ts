import { pgTable, bigserial, bigint, text, numeric, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Sub-ledger tie-out / reconciliation (WS1.4, GL-14). One row per (tenant, subledger, as-of date):
// the GL control-account balance vs the summed sub-ledger detail, the variance, and a maker-checker
// certification (certifiedBy MUST differ from runBy — SELF_CERTIFY).
export const subledgerTieoutRuns = pgTable('subledger_tieout_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  subledger: text('subledger').notNull(),           // 'AR' | 'AP' | 'INV' | 'FA'
  controlAccount: text('control_account').notNull(),// e.g. '1100'
  asOfDate: text('as_of_date').notNull(),           // bizYmdDash
  glBalance: numeric('gl_balance').notNull(),
  subledgerBalance: numeric('subledger_balance').notNull(),
  variance: numeric('variance').notNull(),          // gl - subledger
  status: text('status').notNull().default('Open'), // 'Open' | 'Matched' | 'Variance' | 'Certified'
  detail: jsonb('detail'),                           // optional breakdown
  runBy: text('run_by').notNull(),
  certifiedBy: text('certified_by'),
  certifiedAt: timestamp('certified_at', { withTimezone: true }),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqRun: uniqueIndex('uq_subledger_tieout').on(t.tenantId, t.subledger, t.asOfDate),
}));

export type SubledgerTieoutRun = typeof subledgerTieoutRuns.$inferSelect;

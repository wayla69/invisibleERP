import { pgTable, bigserial, bigint, text, numeric, boolean, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// REC-03 — per-period intercompany reconciliation sign-off. A preparer reconciles the group's IC balances
// (Due-From 1150 vs Due-To 2150) for the period and signs (Prepared); an independent approver (SoD) approves
// (Approved). consolidation.runConsolidation() is GATED on an Approved row for (group, period) so IC balances
// are reconciled BEFORE consolidation eliminates them. Owned by the HQ (group) tenant; RLS-scoped.
export const icReconPeriods = pgTable('ic_recon_periods', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // HQ / group-owning tenant
  groupId: bigint('group_id', { mode: 'number' }).notNull(),                      // → consolidation_groups.id
  period: text('period').notNull(),                                               // 'YYYY-MM'
  status: text('status').notNull().default('Open'),                               // Open | Prepared | Approved | Rejected
  totalDueFrom: numeric('total_due_from', { precision: 18, scale: 4 }).default('0'),
  totalDueTo: numeric('total_due_to', { precision: 18, scale: 4 }).default('0'),
  eliminates: boolean('eliminates').default(false),     // |due_from − due_to| < 0.01
  unmatchedCount: integer('unmatched_count').default(0), // outstanding (from→to) pairs at prepare time
  preparedBy: text('prepared_by'),
  preparedAt: timestamp('prepared_at', { withTimezone: true }),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byGroup: index('idx_ic_recon_group').on(t.groupId, t.period),
  uqPeriod: uniqueIndex('uq_ic_recon_period').on(t.tenantId, t.groupId, t.period),
}));

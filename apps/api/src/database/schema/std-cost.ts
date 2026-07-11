// INV-4 (control COST-02) — Standard-cost roll / inventory revaluation. A periodic, MAKER-CHECKER revision of
// the stored standard cost of STD-costed items (item_costing.standard_cost, set once via /api/costing/config
// and never rolled until now). A preparer PROPOSES a new standard per item; a DISTINCT approver approves it
// (approved_by ≠ prepared_by → 403 SOD_SELF_APPROVAL). On approval, for every line the on-hand inventory is
// revalued at the new standard — revaluation = on_hand_snapshot × (new_std − old_std) — the stored standard
// is rolled forward, and a balanced revaluation JE is posted (Dr/Cr 1200 Inventory ↔ 5500 std-cost variance,
// following the PPV posting convention in costing.service.ts). Draft → Approved is the only transition.
// tenant_id REQUIRED → canonical 0232-form tenant_isolation RLS (migration 0341).
import { pgTable, bigserial, bigint, text, numeric, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Header — one governed standard-cost revision (a "roll"). status ∈ Draft | Approved.
export const stdCostRevisions = pgTable('std_cost_revisions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  revNo: text('rev_no').notNull(),
  status: text('status').notNull().default('Draft'), // Draft | Approved
  reason: text('reason'),                             // preparer's justification for the roll
  revaluationTotal: numeric('revaluation_total', { precision: 18, scale: 2 }).default('0'), // Σ line revaluation
  jeNo: text('je_no'),                                // posted revaluation JE entry_no (set on approval)
  preparedBy: text('prepared_by'),
  preparedAt: timestamp('prepared_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqNo: unique('uq_std_cost_rev_no').on(t.revNo),
  // Tenant-leading index (docs/27 R1-1 / AUD-ARC-01) — the revision list filters by tenant + status.
  byTenant: index('idx_std_cost_rev_tenant').on(t.tenantId, t.status),
}));

// Line — the per-item proposed roll + the on-hand snapshot taken at revise time + the computed revaluation.
export const stdCostRevisionLines = pgTable('std_cost_revision_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  revNo: text('rev_no').notNull(),
  itemId: text('item_id').notNull(),
  oldStd: numeric('old_std', { precision: 14, scale: 4 }),          // stored standard at revise time
  newStd: numeric('new_std', { precision: 14, scale: 4 }),          // proposed new standard
  onHandSnapshot: numeric('on_hand_snapshot', { precision: 18, scale: 4 }), // item_costing.on_hand at revise time
  revaluationAmount: numeric('revaluation_amount', { precision: 18, scale: 2 }), // on_hand × (new − old)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_std_cost_rev_line_tenant').on(t.tenantId, t.revNo),
  byItem: index('idx_std_cost_rev_line_item').on(t.tenantId, t.itemId),
}));

export type StdCostRevision = typeof stdCostRevisions.$inferSelect;
export type StdCostRevisionLine = typeof stdCostRevisionLines.$inferSelect;

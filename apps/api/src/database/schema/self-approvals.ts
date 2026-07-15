import { pgTable, bigserial, bigint, text, numeric, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// SME-01 evidence (docs/49, migration 0413) — one row per ALLOWED self-approval: a maker-checker step
// where maker === checker under tenants.control_profile='sme'. Written ONLY by
// ControlProfileService.recordSelfApproval (common/control-profile.service.ts); read by the
// `sme_self_approval_review` BI report routed to the external accountant + the platform owner.
// Tenant-scoped: canonical 0232-form RLS + idx_self_approvals_tenant.
export const selfApprovals = pgTable('self_approvals', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  event: text('event').notNull(),          // maker-checker event key, e.g. 'gl.je.approve'
  ref: text('ref').notNull(),              // business document reference (JE no, quote no, ...)
  username: text('username').notNull(),    // the person who was both maker and checker
  amount: numeric('amount', { precision: 14, scale: 2 }), // THB at stake, when monetary
  reason: text('reason').notNull(),        // mandatory justification
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type SelfApproval = typeof selfApprovals.$inferSelect;

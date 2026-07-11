import { pgTable, bigserial, bigint, text, timestamp, date } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// GRC-5 (ITGC-AC-22): SoD-Conflict Register + Compensating-Control governance. SoD conflicts are computed
// LIVE per user (detectSodConflicts over SOD_RULES R01..R21) and BLOCKED at grant time (ITGC-AC-09); this
// table is the standing governance layer over the CURRENT conflict population — a decision record per
// (rule_id, username). An `accepted` disposition is a conscious residual-risk acceptance and MUST carry a
// documented compensating_control, an accountable owner and an expiry_date; it records who accepted it and
// is periodically re-reviewed (last_reviewed_at). The detective "expired" worklist flags acceptances past
// expiry or overdue for re-review. Tenant-scoped (RLS via migration 0336, canonical 0232 org-clause form).
export const sodConflictDispositions = pgTable('sod_conflict_dispositions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  ruleId: text('rule_id').notNull(),                        // SOD_RULES id, e.g. R07
  username: text('username').notNull(),                     // the user holding both sides
  status: text('status').notNull().default('open'),         // open | accepted | mitigated | resolved
  compensatingControl: text('compensating_control'),        // mandatory when accepted
  owner: text('owner'),                                     // owner of the compensating control
  acceptedBy: text('accepted_by'),                          // who accepted the residual risk (evidence)
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  expiryDate: date('expiry_date'),                          // acceptance expiry — re-decision by this date
  lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type SodConflictDisposition = typeof sodConflictDispositions.$inferSelect;

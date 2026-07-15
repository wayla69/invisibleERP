import { pgTable, bigserial, bigint, text, integer, numeric, timestamp, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// SME-02 (docs/49, migration 0417) — attestation that the SME-01 self-approval review was OPERATED.
// One row per (tenant, period, reviewer_kind): the external accountant (`reviewer_kind='accountant'`, a
// tenant user holding the `sme_review` duty) and the platform owner (`'platform'`, a god acting-as the
// tenant) each sign off a period's self-approvals. Written by SmeReviewService.signoff; read by the
// SME-01 report (outstanding legs) + the /sme-review screen. Tenant-scoped: canonical 0232-form RLS +
// idx_sme_review_signoffs_tenant.
export const smeReviewSignoffs = pgTable('sme_review_signoffs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  period: text('period').notNull(),                 // 'YYYY-MM' business month (Asia/Bangkok)
  reviewerKind: text('reviewer_kind').notNull(),    // 'accountant' | 'platform'
  reviewerUsername: text('reviewer_username').notNull(),
  itemCount: integer('item_count').notNull().default(0),      // snapshot of self-approvals in the period
  totalAmount: numeric('total_amount', { precision: 14, scale: 2 }).notNull().default('0'),
  note: text('note'),
  signedAt: timestamp('signed_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uq: unique('sme_review_signoffs_uq').on(t.tenantId, t.period, t.reviewerKind),
}));

export type SmeReviewSignoff = typeof smeReviewSignoffs.$inferSelect;

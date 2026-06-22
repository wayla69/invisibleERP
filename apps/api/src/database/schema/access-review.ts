import { pgTable, bigserial, bigint, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ITGC-AC-08: User Access Review (UAR) attestation. Each row is a periodic recertification sign-off —
// who reviewed, when, the population reviewed, and how many SoD conflicts were outstanding at the time.
export const accessReviews = pgTable('access_reviews', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  period: text('period').notNull(),                 // e.g. '2026-Q2'
  reviewedBy: text('reviewed_by').notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }).defaultNow(),
  userCount: integer('user_count'),                 // population size at review time
  conflictUserCount: integer('conflict_user_count'),// users with an SoD conflict at review time
  notes: text('notes'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
});

export type AccessReview = typeof accessReviews.$inferSelect;

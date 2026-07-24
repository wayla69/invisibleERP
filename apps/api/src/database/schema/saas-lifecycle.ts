import { bigint, bigserial, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// SaaS lifecycle event ledger (A2, migration 0453). Platform-level (about_tenant_id — NOT tenant_id, so
// the RLS loop + tenant-index guard skip it, mirroring platform_emails/platform_notifications). One row
// per lifecycle side effect ever taken; dedup_key is the idempotency anchor — the daily job inserts with
// ON CONFLICT DO NOTHING and only performs the side effect (email / suspend / activate) when the insert
// actually landed, so re-runs and overlapping schedules can never double-remind or double-suspend.
export const saasLifecycleEvents = pgTable('saas_lifecycle_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  event: text('event').notNull(), // trial_reminder_7 | trial_reminder_1 | trial_expired | trial_free_activated | trial_suspended | dunning_1 | dunning_2 | dunning_3 | pastdue_suspended | dunning_cleared
  dedupKey: text('dedup_key').notNull(),
  aboutTenantId: bigint('about_tenant_id', { mode: 'number' }).notNull(),
  detail: jsonb('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byDedup: uniqueIndex('saas_lifecycle_events_dedup_uq').on(t.dedupKey),
  byTenant: index('saas_lifecycle_events_tenant_idx').on(t.aboutTenantId, t.createdAt),
}));

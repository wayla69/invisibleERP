import { bigint, bigserial, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// Entitlement observation ledger (B1, migration 0455). Platform-level (about_tenant_id — NOT tenant_id,
// so the RLS loop + tenant-index guard skip it, mirroring saas_lifecycle_events/platform_emails). One row
// per (business day × tenant × deny code × mode × route-perm set) the PlanGuard would block (shadow) or
// did block (enforce) — dedup_key is the idempotency anchor (insert ON CONFLICT DO NOTHING, plus an
// in-process first-seen gate so the hot path pays at most one insert per unique denial per day per
// process). Gods read it via GET /api/admin/entitlement-observations to see WHO would break BEFORE
// flipping a tenant into the enforcement cohort.
export const entitlementObservations = pgTable('entitlement_observations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  day: text('day').notNull(), // Asia/Bangkok business day, YYYY-MM-DD
  aboutTenantId: bigint('about_tenant_id', { mode: 'number' }).notNull(),
  code: text('code').notNull(), // TRIAL_EXPIRED | SUBSCRIPTION_INACTIVE | SUBSCRIPTION_PASTDUE_READONLY | SUITE_NOT_ENTITLED | PLAN_FEATURE_REQUIRED
  mode: text('mode').notNull(), // 'shadow' (would block) | 'enforce' (did block)
  routePerms: text('route_perms').notNull().default(''),
  dedupKey: text('dedup_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byDedup: uniqueIndex('entitlement_observations_dedup_uq').on(t.dedupKey),
  byTenant: index('entitlement_observations_tenant_idx').on(t.aboutTenantId, t.createdAt),
}));

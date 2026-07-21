-- 0455_entitlement_observations — entitlement-enforcement observation ledger (B1: rollout wave B).
-- One row per (business day × tenant × deny code × mode × route-perm set) the PlanGuard WOULD block
-- (shadow mode) or DID block (enforce mode); dedup_key is the idempotency anchor — the guard inserts
-- ON CONFLICT DO NOTHING behind an in-process first-seen gate, so the request hot path pays at most
-- one insert per unique denial per day per process. Gods read the ledger (who would break, on what)
-- BEFORE moving a tenant into the ENTITLEMENTS_ENFORCE_TENANTS cohort. Platform-level table: the
-- company column is about_tenant_id (deliberately NOT tenant_id — the generic RLS loop + tenant-index
-- guard skip it, mirroring 0453 saas_lifecycle_events); only gods read it via the @PlatformAdmin bypass.
CREATE TABLE IF NOT EXISTS entitlement_observations (
  id bigserial PRIMARY KEY,
  day text NOT NULL,                 -- Asia/Bangkok business day (YYYY-MM-DD)
  about_tenant_id bigint NOT NULL,   -- deliberately NOT named tenant_id (platform table)
  code text NOT NULL,                -- 'TRIAL_EXPIRED' | 'SUBSCRIPTION_INACTIVE' | 'SUBSCRIPTION_PASTDUE_READONLY' | 'SUITE_NOT_ENTITLED' | 'PLAN_FEATURE_REQUIRED'
  mode text NOT NULL,                -- 'shadow' (would block) | 'enforce' (did block)
  route_perms text NOT NULL DEFAULT '',
  dedup_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS entitlement_observations_dedup_uq ON entitlement_observations (dedup_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entitlement_observations_tenant_idx ON entitlement_observations (about_tenant_id, created_at);
--> statement-breakpoint
-- app_user grants (requests run under SET ROLE app_user). No RLS: platform-level, no tenant scoping.
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
END $$;

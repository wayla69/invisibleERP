-- 0453_saas_lifecycle_events — SaaS lifecycle automation ledger (A2: real-world Platform Console wave 1).
-- One row per lifecycle side effect the daily 'saas_lifecycle' job ever takes (trial reminders, expiry,
-- grace-end auto-suspend, PastDue dunning ladder, cycle clear); dedup_key is the idempotency anchor —
-- the job inserts ON CONFLICT DO NOTHING and only fires the side effect (email / suspend / activate)
-- when the insert landed, so re-runs never double-remind or double-suspend. Platform-level table: the
-- company column is about_tenant_id (deliberately NOT tenant_id — the generic RLS loop + tenant-index
-- guard skip it, mirroring 0452 platform_emails); only gods read it via the @PlatformAdmin bypass.
CREATE TABLE IF NOT EXISTS saas_lifecycle_events (
  id bigserial PRIMARY KEY,
  event text NOT NULL,               -- 'trial_reminder_7' | 'trial_reminder_1' | 'trial_expired' | 'trial_free_activated' | 'trial_suspended' | 'dunning_1' | 'dunning_2' | 'dunning_3' | 'pastdue_suspended' | 'dunning_cleared'
  dedup_key text NOT NULL,
  about_tenant_id bigint NOT NULL,   -- deliberately NOT named tenant_id (platform table)
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS saas_lifecycle_events_dedup_uq ON saas_lifecycle_events (dedup_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS saas_lifecycle_events_tenant_idx ON saas_lifecycle_events (about_tenant_id, created_at);
--> statement-breakpoint
-- app_user grants (requests run under SET ROLE app_user). No RLS: platform-level, no tenant scoping.
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
END $$;

-- 0247_platform_notifications — god-facing platform event feed (docs/ops/tenancy-model §2quinquies). Platform
-- owners ("god") get an inbox of cross-company events that need attention (a new signup request, a company
-- suspended/reactivated/provisioned). Platform-level (no tenant_id ⇒ the RLS loop never treats these as
-- tenant-scoped); only gods read them via the @PlatformAdmin bypass. Per-god read state in a side table.
CREATE TABLE IF NOT EXISTS platform_notifications (
  id bigserial PRIMARY KEY,
  type text NOT NULL,                 -- 'signup_request' | 'company_provisioned' | 'tenant_suspended' | 'tenant_reactivated'
  title text NOT NULL,
  body text,
  about_tenant_id bigint,             -- which company it's about (nullable); deliberately NOT named tenant_id
                                      -- so the RLS loop + tenant-index guard don't treat this platform table
                                      -- as tenant-scoped (mirrors signup_requests.created_tenant_id).
  ref_type text,
  ref_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS platform_notifications_created_idx ON platform_notifications (created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS platform_notification_reads (
  id bigserial PRIMARY KEY,
  notification_id bigint NOT NULL REFERENCES platform_notifications(id) ON DELETE CASCADE,
  username text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS platform_notification_reads_uq ON platform_notification_reads (notification_id, username);
--> statement-breakpoint
-- app_user grants (interceptor runs under SET ROLE app_user). No RLS: platform-level, no tenant scoping.
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
END $$;

-- 0286: scheduler heartbeats (docs/27 R1-5 residual / AUD-ARC-07 — silent cron-death detection).
-- One row per scheduler name ('bi_scheduler'), stamped on every due-sweep (external cron, manual run,
-- or the optional in-process tick). The job worker's reap cycle alerts when a heartbeat that EXISTS goes
-- stale — a scheduler that was working and silently died. PLATFORM-level table BY DESIGN: no tenant_id
-- column (the tenant-idx gate and the generic RLS loop must skip it — see CLAUDE.md), read/written only
-- by system paths.
CREATE TABLE IF NOT EXISTS "scheduler_heartbeats" (
  "name" text PRIMARY KEY,
  "last_run_at" timestamptz NOT NULL DEFAULT now(),
  "source" text,
  "detail" jsonb
);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON scheduler_heartbeats TO app_user';
  END IF;
END $$;
--> statement-breakpoint
-- Drop the two LEGACY 0042-era RLS policies that cast the tenant GUC without NULLIF
-- (`current_setting('app.tenant_id')::bigint`): with an EMPTY app.tenant_id (a bypass/system context,
-- e.g. the cross-tenant scheduler sweep) the cast throws 22P02 as soon as rows exist, even though the
-- bypass arm of the OR is true. Both tables are ALSO covered by the canonical `tenant_isolation` policy
-- (0232 form, NULLIF-safe, org-sharing aware) — the legacy duplicates add no isolation, only the crash.
DROP POLICY IF EXISTS report_sub_isolation ON report_subscriptions;
--> statement-breakpoint
DROP POLICY IF EXISTS bi_snapshot_isolation ON bi_daily_snapshots;

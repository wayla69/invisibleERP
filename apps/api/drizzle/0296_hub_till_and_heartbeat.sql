-- 0296 — Store-hub Phase 2c/4a (docs/41): till/Z-report up-sync (control BRANCH-05) + hub heartbeat.
--
-- 1. hub_push_log gains `doc_type` so the same idempotency ledger tracks non-sale documents
--    (a till session pushes under doc_type='till', keyed by its session_no in hub_sale_no).
-- 2. hub_heartbeats: one row per hub box per tenant — liveness + backlog + clock skew, so a silent
--    or stuck hub is visible to HQ/the platform owner instead of quietly hoarding un-replayed cash.
ALTER TABLE hub_push_log ADD COLUMN IF NOT EXISTS doc_type TEXT NOT NULL DEFAULT 'sale';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hub_heartbeats (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT REFERENCES tenants(id),
  hub_id            TEXT NOT NULL,             -- stable per-box id (HUB_ID env; defaults to the hostname)
  app_version       TEXT,
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_push_at      TIMESTAMPTZ,               -- when the hub last successfully replayed a document
  pending_sales     INTEGER NOT NULL DEFAULT 0, -- un-replayed sales sitting on the box (backlog)
  pending_tills     INTEGER NOT NULL DEFAULT 0,
  failed_docs       INTEGER NOT NULL DEFAULT 0, -- rows stuck in hub_push_log.status='failed'
  skipped_docs      INTEGER NOT NULL DEFAULT 0, -- 'skipped_unsupported' — the manual-review queue
  clock_skew_sec    INTEGER,                   -- hub clock − cloud clock, at receipt (business-day drift)
  created_at        TIMESTAMPTZ DEFAULT now()
);
--> statement-breakpoint
-- leading (tenant_id, …) index satisfies the cutover/tenant-idx gate; unique per box.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hub_heartbeat ON hub_heartbeats (tenant_id, hub_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hub_heartbeat_seen ON hub_heartbeats (tenant_id, last_seen_at);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new
-- table gets RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))',
      r.table_name);
  END LOOP;
END $$;

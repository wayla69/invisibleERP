-- 0379_audience_exports — G3 (docs/45): consent-gated hashed audience export register (PDPA-05 control).
-- The cdp_export_sync hook gains a REAL, safe activation target: the new audience_export_sync BI job pushes
-- SHA-256-HASHED phone/email rows (the Meta Custom Audiences / Google Customer Match ingest format — raw
-- PII never leaves) for ONLY the members with a live marketing consent in member_consents (granted, not
-- withdrawn; NO fallback to the legacy marketingOptIn flag — the ledger is the legal basis). The job is
-- FAIL-CLOSED: it refuses to run without an ACTIVE ROPA activity named 'audience_export' with
-- legal_basis='consent' (ROPA_MISSING), and every attempt — success, failed, or blocked — lands here as an
-- append-only register row: who ran it, the consent basis, considered/consented/pushed counts, the target,
-- and the ROPA row it ran under. This register + the ROPA row are the PDPA-05 audit evidence.
CREATE TABLE IF NOT EXISTS audience_exports (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  purpose text NOT NULL DEFAULT 'marketing',
  consent_basis text NOT NULL DEFAULT 'member_consents:marketing',
  target text NOT NULL,                    -- webhook | mock
  hash_alg text NOT NULL DEFAULT 'sha256',
  members_considered bigint NOT NULL DEFAULT 0,
  members_consented bigint NOT NULL DEFAULT 0,
  rows_pushed bigint NOT NULL DEFAULT 0,
  status text NOT NULL,                    -- success | failed | blocked
  error text,
  ropa_activity_id bigint,                 -- ropa_activities soft FK; NULL only on a blocked run
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audience_exports_tenant ON audience_exports (tenant_id, created_at);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new table
-- gets RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

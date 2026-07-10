-- 0293 — Store-hub → cloud replay tracking (docs/41 Phase 2a, control BRANCH-04).
-- One row per hub-captured sale: which were pushed to the cloud ingest endpoint, the cloud's canonical
-- sale_no they mapped to, and — crucially for the reconciliation control — the sales the pusher could
-- NOT replay (status 'skipped_unsupported'): visible, never silently dropped.
CREATE TABLE IF NOT EXISTS hub_push_log (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT REFERENCES tenants(id),
  hub_sale_no   TEXT NOT NULL,               -- the sale on THIS hub's ledger
  client_uuid   TEXT NOT NULL,               -- deterministic idempotency key (hub:{tenant}:{hub_sale_no})
  status        TEXT NOT NULL DEFAULT 'pushed', -- pushed | duplicate | failed | skipped_unsupported
  cloud_sale_no TEXT,                        -- canonical sale_no minted by the cloud at ingest
  hub_total     NUMERIC(14,2),               -- hub-side value (reconciliation tie-out vs cloud)
  skip_reason   TEXT,                        -- why an unsupported sale was skipped (BRANCH-04 evidence)
  error_code    TEXT,
  error_message TEXT,
  attempts      INTEGER NOT NULL DEFAULT 1,
  pushed_at     TIMESTAMPTZ DEFAULT now(),
  created_at    TIMESTAMPTZ DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_hub_push_sale ON hub_push_log (tenant_id, hub_sale_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hub_push_status ON hub_push_log (tenant_id, status);
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

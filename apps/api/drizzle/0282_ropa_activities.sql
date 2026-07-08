-- 0282_ropa_activities (4.6, PDPA-03): Records of Processing Activities register (PDPA มาตรา 39 / GDPR Art.30).
-- A maintained inventory of processing activities — the register a DPA/auditor asks for. Tenant-scoped + RLS
-- (like dsar_requests / pdpa_erasures, migration 0180).
CREATE TABLE IF NOT EXISTS ropa_activities (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT REFERENCES tenants(id),
  name              TEXT NOT NULL,
  purpose           TEXT NOT NULL,
  legal_basis       TEXT NOT NULL,                          -- consent | contract | legal_obligation | legitimate_interest | vital_interest | public_task
  data_categories   JSONB NOT NULL DEFAULT '[]'::jsonb,
  data_subjects     JSONB NOT NULL DEFAULT '[]'::jsonb,
  recipients        JSONB NOT NULL DEFAULT '[]'::jsonb,
  sub_processors    JSONB NOT NULL DEFAULT '[]'::jsonb,
  retention_period  TEXT,
  cross_border      TEXT,
  security_measures TEXT,
  active            BOOLEAN NOT NULL DEFAULT true,
  created_by        TEXT,
  updated_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ropa_tenant ON ropa_activities (tenant_id, active);
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

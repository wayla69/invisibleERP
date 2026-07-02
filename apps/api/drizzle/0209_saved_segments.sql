-- 0209_saved_segments — Phase D1: reusable, tenant-defined customer segments (a named set of field/op/value
-- rules over member + RFM-profile fields, combined all/any), beyond the fixed RFM buckets. Resolved to the
-- matching members on demand (whitelisted columns + bound values). Tenant-scoped → re-run the RLS loop.
-- Mirrors 0208_tenant_messaging_config.
CREATE TABLE IF NOT EXISTS saved_segments (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  match_mode text NOT NULL DEFAULT 'all',
  rules jsonb NOT NULL DEFAULT '[]',
  created_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS saved_segments_tenant ON saved_segments (tenant_id);
--> statement-breakpoint
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)', r.table_name);
  END LOOP;
END $$;

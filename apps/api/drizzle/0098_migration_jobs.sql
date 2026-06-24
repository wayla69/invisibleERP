-- 0098 — E2 (Platform Phase 27) data-migration toolkit. Records dry-run migration jobs (source adapter →
-- canonical → per-row validation), so a tenant previews before committing via the Phase-7 importer. New
-- tenant_id table → RLS loop re-run. Validation only — no GL.

CREATE TABLE IF NOT EXISTS migration_jobs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  source text NOT NULL,
  entity text NOT NULL,
  status text NOT NULL DEFAULT 'validated',
  rows_total integer DEFAULT 0,
  rows_valid integer DEFAULT 0,
  rows_error integer DEFAULT 0,
  detail jsonb DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id table is isolation-scoped.
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

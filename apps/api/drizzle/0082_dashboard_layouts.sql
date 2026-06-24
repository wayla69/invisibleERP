-- 0082 — Role-based dashboard layouts (Platform Phase 5). An admin configures, per role, which KPI widgets
-- appear on the home dashboard (drawn from a fixed catalog of metrics that already exist). At view time each
-- user gets their role's layout, filtered to the widgets their permissions allow, with live values computed
-- RLS-scoped. One layout per (tenant, role). New tenant_id table → re-run the 0002 RLS loop.

CREATE TABLE IF NOT EXISTS dashboard_layouts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  role role_enum NOT NULL,
  widgets jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ordered array of catalog widget keys
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_layouts_tenant_role ON dashboard_layouts (tenant_id, role);
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

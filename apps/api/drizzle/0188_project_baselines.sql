-- 0188_project_baselines — change-controlled project baselines (PPM next-level B1, docs/20; control PROJ-07).
-- A baseline snapshots the approved plan (BAC + critical-path duration) at a point in time. Re-baselining
-- requires a reason and preserves history (the prior active row → superseded), so a project can't silently
-- move its goalposts; variance of the current plan vs the active baseline surfaces scope/cost creep.
-- Tenant-scoped → re-run the RLS loop (idempotent: DROP POLICY IF EXISTS).
CREATE TABLE IF NOT EXISTS project_baselines (
  id bigserial PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES projects(id),
  tenant_id bigint REFERENCES tenants(id),
  label text,
  baseline_bac numeric(16,2) DEFAULT 0,
  baseline_duration_days integer DEFAULT 0,
  baseline_end date,
  reason text,
  status text NOT NULL DEFAULT 'active',              -- active | superseded
  created_by text,
  captured_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pbaseline_project ON project_baselines (project_id);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id table is isolation-scoped (idempotent — DROP POLICY IF EXISTS).
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

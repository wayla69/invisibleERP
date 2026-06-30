-- 0198_project_health_snapshots — periodic project health (EVM/RAG) snapshots (PPM upgrade). Portfolio/EVM
-- are computed live, so there is no trend over time; this persists a dated snapshot (CPI/SPI/% complete/RAG +
-- the EVM figures) per project so a status report can show the trajectory. Captured on demand or by the
-- scheduled BI action job `project_health_capture` (idempotent per project+date). Tenant-scoped → RLS loop.
CREATE TABLE IF NOT EXISTS project_health_snapshots (
  id bigserial PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES projects(id),
  tenant_id bigint REFERENCES tenants(id),
  snapshot_date date NOT NULL,
  rag text NOT NULL DEFAULT 'no_data',     -- green | amber | red | no_data
  cpi numeric(10,4),
  spi numeric(10,4),
  pct_complete numeric(5,2),
  bac numeric(16,2) DEFAULT 0,
  ev numeric(16,2) DEFAULT 0,
  ac numeric(16,2) DEFAULT 0,
  eac numeric(16,2) DEFAULT 0,
  margin numeric(16,2) DEFAULT 0,
  wip numeric(16,2) DEFAULT 0,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_phs_project_date ON project_health_snapshots (project_id, snapshot_date);
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

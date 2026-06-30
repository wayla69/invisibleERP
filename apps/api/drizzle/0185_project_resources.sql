-- 0185_project_resources — resource rate card + project resource assignments (PPM roadmap P2, docs/19).
-- resource_rates: effective-dated cost/bill rate per role — labor cost/bill estimates are governed by an
-- authorized rate card (PROJ-05). project_resources: a named resource (role) allocated to a project (optionally
-- a task) for a period at an allocation %, with the rate-card rates snapshotted at assignment; capacity/
-- utilization rolls up allocation per resource and flags >100% over-allocation. Both tenant-scoped → re-run the
-- RLS loop (idempotent: DROP POLICY IF EXISTS).
CREATE TABLE IF NOT EXISTS resource_rates (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  role text NOT NULL,
  cost_rate numeric(14,2) DEFAULT 0,
  bill_rate numeric(14,2) DEFAULT 0,
  effective_from date,
  effective_to date,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rate_role ON resource_rates (tenant_id, role);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_resources (
  id bigserial PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES projects(id),
  tenant_id bigint REFERENCES tenants(id),
  task_id bigint,
  resource_name text NOT NULL,
  role text,
  alloc_pct numeric(5,2) DEFAULT 100,
  period_start date,
  period_end date,
  cost_rate numeric(14,2) DEFAULT 0,
  bill_rate numeric(14,2) DEFAULT 0,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_presource_project ON project_resources (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_presource_name ON project_resources (tenant_id, resource_name);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id tables are isolation-scoped (idempotent — DROP POLICY IF EXISTS).
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

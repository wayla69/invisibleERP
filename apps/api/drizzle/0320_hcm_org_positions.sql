-- 0320_hcm_org_positions — HR-1 (docs/42 HCM depth): organisation structure, positions & effective-dated
-- assignments on the payroll.employees identity (emp_code). Three tenant-scoped tables:
--   hr_departments  — per-tenant department hierarchy (parent_dept_id self-ref), GL cost-centre link, manager.
--   hr_positions    — budgeted seats within a department (reports_to_position_id self-ref, budgeted_headcount).
--   hr_assignments  — effective-dated employee→position link (end_date NULL = still active); the count of
--                     active assignments is what the HR-01 headcount-governance control checks against
--                     hr_positions.budgeted_headcount (block HEADCOUNT_EXCEEDED unless an exec overrides).
-- Each table gets a leading (tenant_id, …) index and the CANONICAL 0232-form tenant_isolation RLS policy
-- (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS hr_departments (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  dept_code text NOT NULL,
  name text NOT NULL,
  parent_dept_id bigint,
  cost_center text,
  manager_emp_code text,
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_dept_code ON hr_departments (tenant_id, dept_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_dept_parent ON hr_departments (tenant_id, parent_dept_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hr_positions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  position_code text NOT NULL,
  title text NOT NULL,
  job_grade text,
  dept_id bigint REFERENCES hr_departments(id),
  reports_to_position_id bigint,
  budgeted_headcount integer NOT NULL DEFAULT 1,
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_hr_position_code ON hr_positions (tenant_id, position_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_position_dept ON hr_positions (tenant_id, dept_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hr_assignments (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  emp_code text NOT NULL,
  position_id bigint NOT NULL REFERENCES hr_positions(id),
  effective_date date NOT NULL,
  end_date date,
  is_primary boolean DEFAULT true,
  assigned_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_assign_position ON hr_assignments (tenant_id, position_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_assign_emp ON hr_assignments (tenant_id, emp_code);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the three new
-- tables get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

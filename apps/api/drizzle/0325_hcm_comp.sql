-- 0325_hcm_comp — HR-6 (docs/42 HCM depth, Wave 2): compensation bands + benefits on the payroll.employees
-- identity (emp_code). Four tenant-scoped tables:
--   pay_grades         — per-tenant salary-band register (min/mid/max) that the HR-06 band check enforces.
--   comp_changes       — effective-dated salary/grade change requests (pending→approved|rejected); the HR-06
--                        control validates new_salary within the target grade's [min,max] band (OUT_OF_BAND
--                        unless an hr_admin/exec overrides) and the maker-checker (approved_by ≠ requested_by,
--                        employee master written only on approval).
--   benefit_plans      — per-tenant catalogue of benefit offerings (employer/employee cost).
--   benefit_enrollments— effective-dated employee→plan link (end_date NULL = active).
-- Each table gets a leading (tenant_id, …) index and the CANONICAL 0232-form tenant_isolation RLS policy
-- (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS pay_grades (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  grade_code text NOT NULL,
  name text NOT NULL,
  min_salary numeric(14,2) NOT NULL DEFAULT 0,
  mid_salary numeric(14,2) NOT NULL DEFAULT 0,
  max_salary numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'THB',
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_pay_grade_code ON pay_grades (tenant_id, grade_code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS comp_changes (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  emp_code text NOT NULL,
  change_type text NOT NULL,
  old_salary numeric(14,2),
  new_salary numeric(14,2) NOT NULL,
  new_grade text,
  effective_date date NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'pending',
  requested_by text,
  approved_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_comp_change_emp ON comp_changes (tenant_id, emp_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_comp_change_status ON comp_changes (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS benefit_plans (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  plan_code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  employer_cost numeric(14,2) NOT NULL DEFAULT 0,
  employee_cost numeric(14,2) NOT NULL DEFAULT 0,
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_benefit_plan_code ON benefit_plans (tenant_id, plan_code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS benefit_enrollments (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  emp_code text NOT NULL,
  plan_id bigint NOT NULL REFERENCES benefit_plans(id),
  enrolled_date date NOT NULL,
  end_date date,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_benefit_enroll_emp ON benefit_enrollments (tenant_id, emp_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_benefit_enroll_plan ON benefit_enrollments (tenant_id, plan_id);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the four new
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

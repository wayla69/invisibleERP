-- 0327_hcm_ess — HR-8 (docs/42 HCM depth, Wave 3): Employee Self-Service (ESS) depth on the payroll.employees
-- identity (emp_code). Adds:
--   • Four nullable ESS-editable columns on employees (phone, address, emergency_contact, tax_id) — additive,
--     so existing inserts are unaffected; employees is already tenant-scoped (RLS).
--   • ess_profile_change_requests — an employee-submitted change to a single profile field on their own record;
--     a SENSITIVE field (name/national_id/bank_account/tax_id) is parked `pending` and the employees master is
--     written ONLY when a DIFFERENT hr/hr_admin user approves (HR-08 maker-checker). Low-risk fields auto-apply.
--   • employee_documents — a personal document-center row (file_ref = objstore:<key> or a note).
-- Each new table gets a leading (tenant_id, …) index and the CANONICAL 0232-form tenant_isolation RLS policy
-- (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone text;
--> statement-breakpoint
ALTER TABLE employees ADD COLUMN IF NOT EXISTS address text;
--> statement-breakpoint
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_contact text;
--> statement-breakpoint
ALTER TABLE employees ADD COLUMN IF NOT EXISTS tax_id text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ess_profile_change_requests (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  emp_code text NOT NULL,
  field text NOT NULL,
  old_value text,
  new_value text NOT NULL,
  sensitive text NOT NULL DEFAULT 'false',
  status text NOT NULL DEFAULT 'pending',
  reason text,
  requested_by text,
  approved_by text,
  created_at timestamptz DEFAULT now(),
  decided_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ess_change_emp ON ess_profile_change_requests (tenant_id, emp_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ess_change_status ON ess_profile_change_requests (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS employee_documents (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  emp_code text NOT NULL,
  doc_type text NOT NULL,
  title text NOT NULL,
  file_ref text,
  visibility text NOT NULL DEFAULT 'private',
  uploaded_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_emp_doc_emp ON employee_documents (tenant_id, emp_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_emp_doc_type ON employee_documents (tenant_id, doc_type);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the two new
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

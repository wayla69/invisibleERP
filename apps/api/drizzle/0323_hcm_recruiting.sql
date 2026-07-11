-- 0323_hcm_recruiting — HR-4 (docs/42 HCM depth, Wave 2): Recruiting / ATS. Four tenant-scoped tables carrying
-- the requisition → candidate pipeline → offer → hire flow on the payroll.employees identity:
--   job_requisitions — an approved request to fill N seats of a position; approved_by ≠ requested_by (HR-04
--                      maker-checker). An approved requisition gates its pipeline's offer/hire stages.
--   candidates       — the talent pool (cand_no unique per tenant).
--   applications     — a candidate's journey through one requisition (stage applied→…→hired/rejected).
--   offers           — a proposed hire (status pending→approved→accepted); only an accepted+approved offer may
--                      convert into a payroll.employees row (hiring beyond the requisition headcount → HEADCOUNT_EXCEEDED).
-- Each table gets a leading (tenant_id, …) index and the CANONICAL 0232-form tenant_isolation RLS policy
-- (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS job_requisitions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  req_no text NOT NULL,
  position_id bigint REFERENCES hr_positions(id),
  dept_id bigint,
  headcount integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft',
  justification text,
  requested_by text,
  approved_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_req_no ON job_requisitions (tenant_id, req_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_job_req_status ON job_requisitions (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS candidates (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  cand_no text NOT NULL,
  name text NOT NULL,
  email text,
  phone text,
  source text,
  resume_url text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidate_no ON candidates (tenant_id, cand_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_candidate_email ON candidates (tenant_id, email);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS applications (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  requisition_id bigint NOT NULL REFERENCES job_requisitions(id),
  candidate_id bigint NOT NULL REFERENCES candidates(id),
  stage text NOT NULL DEFAULT 'applied',
  rating numeric(4,2),
  notes text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_application_req ON applications (tenant_id, requisition_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_application_cand ON applications (tenant_id, candidate_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS offers (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  application_id bigint NOT NULL REFERENCES applications(id),
  offered_salary numeric(14,2) NOT NULL DEFAULT 0,
  offered_grade text,
  start_date date,
  status text NOT NULL DEFAULT 'pending',
  created_by text,
  approved_by text,
  hired_emp_code text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_offer_application ON offers (tenant_id, application_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_offer_status ON offers (tenant_id, status);
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

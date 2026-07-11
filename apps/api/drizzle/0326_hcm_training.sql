-- 0326_hcm_training — HR-7 (docs/42 HCM depth, Wave 3): training & certifications on the payroll.employees
-- identity (emp_code). Four tenant-scoped tables:
--   training_courses     — per-tenant course catalogue (course_code unique per tenant; is_mandatory,
--                          requires_score, validity_months = recert cadence).
--   training_sessions    — scheduled deliveries of a course (session_date, instructor, capacity, status).
--   training_enrollments — employee→session (status enrolled→attended→completed|failed, score, completed_date).
--                          The HR-07 control: completing a course with validity_months set MINTS/renews a
--                          certifications row (expiry = completed_date + validity_months); a `completed` with
--                          no score on a requires_score course is blocked (SCORE_REQUIRED).
--   certifications       — employee credential (cert_code/name, issued_date, expiry_date nullable, source
--                          course_id nullable, is_mandatory, status active→expired). The detective read
--                          GET /api/hcm/training/compliance?days=N surfaces expired/expiring mandatory certs.
-- Each table gets a leading (tenant_id, …) index and the CANONICAL 0232-form tenant_isolation RLS policy
-- (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS training_courses (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  course_code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  is_mandatory boolean NOT NULL DEFAULT false,
  requires_score boolean NOT NULL DEFAULT false,
  pass_score numeric(6,2),
  validity_months integer,
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_training_course_code ON training_courses (tenant_id, course_code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS training_sessions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  course_id bigint NOT NULL REFERENCES training_courses(id),
  session_date date NOT NULL,
  instructor text,
  location text,
  capacity integer,
  status text NOT NULL DEFAULT 'scheduled',
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_training_session_course ON training_sessions (tenant_id, course_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_training_session_status ON training_sessions (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS training_enrollments (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  session_id bigint NOT NULL REFERENCES training_sessions(id),
  emp_code text NOT NULL,
  status text NOT NULL DEFAULT 'enrolled',
  score numeric(6,2),
  completed_date date,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_training_enroll_emp ON training_enrollments (tenant_id, emp_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_training_enroll_session ON training_enrollments (tenant_id, session_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS certifications (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  emp_code text NOT NULL,
  cert_code text NOT NULL,
  name text NOT NULL,
  source_course_id bigint REFERENCES training_courses(id),
  is_mandatory boolean NOT NULL DEFAULT false,
  issued_date date NOT NULL,
  expiry_date date,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_certification_emp ON certifications (tenant_id, emp_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_certification_expiry ON certifications (tenant_id, expiry_date);
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

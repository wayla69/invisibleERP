-- 0322_hcm_performance — HR-3 Performance management (docs/42 HCM depth). Three tenant-scoped tables for the
-- appraisal loop: perf_cycles (open→calibration→closed), perf_goals (OKR-style objectives with weight_pct that
-- validate ≤100% per employee/cycle), and perf_reviews (self→manager→calibration→sign-off). Control HR-03
-- (review sign-off SoD): manager rating + sign-off must be by someone OTHER than the reviewee. Each table gets
-- a leading (tenant_id,…) index + the CANONICAL 0232-form tenant_isolation RLS policy (org-sharing clause).
CREATE TABLE IF NOT EXISTS perf_cycles (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  period_start date,
  period_end date,
  status text NOT NULL DEFAULT 'open',
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_perf_cycles_tenant ON perf_cycles (tenant_id, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS perf_goals (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  cycle_id bigint NOT NULL,
  emp_code text NOT NULL,
  title text NOT NULL,
  description text,
  weight_pct numeric(6,2) DEFAULT 0,
  metric text,
  target text,
  status text NOT NULL DEFAULT 'draft',
  progress_pct numeric(6,2) DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_perf_goals_tenant ON perf_goals (tenant_id, cycle_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_perf_goals_emp ON perf_goals (emp_code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS perf_reviews (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  cycle_id bigint NOT NULL,
  emp_code text NOT NULL,
  self_rating numeric(4,2),
  manager_rating numeric(4,2),
  manager_emp_code text,
  calibrated_rating numeric(4,2),
  comments text,
  status text NOT NULL DEFAULT 'self',
  signed_by text,
  signed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_perf_reviews_tenant ON perf_reviews (tenant_id, cycle_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_perf_reviews_emp ON perf_reviews (emp_code);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new tables
-- get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

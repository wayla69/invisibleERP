-- docs/59 Track D (D4) — forecast-accuracy monitoring (control SCM-07).
--
-- scm_accuracy_history: the REALIZED WAPE/bias per (tenant, branch, item, as_of_date), computed by
-- comparing a prior forecast to the actuals that have since arrived, judged against the series' fit-time
-- baseline (fit_wape). `degraded` = realized WAPE above the baseline by the configured factor for the
-- configured number of consecutive as-of dates (the SCM-07 detective teeth). Plus two additive
-- scm_settings knobs (default-preserving) that configure the degradation test.
--
-- Tenancy: scm_accuracy_history carries tenant_id, so the trailing DO block's CANONICAL 0232-form org
-- loop enables tenant_isolation; the leading (tenant_id, …) index satisfies the cutover:tenant-idx gate.
-- Only the scm-planning accuracy refresh writes it (no cross-writer NULL-tenant fan-out to sweep).
ALTER TABLE scm_settings ADD COLUMN IF NOT EXISTS accuracy_degradation_factor numeric(6,3) NOT NULL DEFAULT 1.5;
--> statement-breakpoint
ALTER TABLE scm_settings ADD COLUMN IF NOT EXISTS accuracy_sustained_periods integer NOT NULL DEFAULT 3;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS scm_accuracy_history (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  branch_id bigint,
  item_id text NOT NULL,
  as_of_date date NOT NULL,                            -- the business day the accuracy was reconciled
  wape numeric(10,4),                                  -- realized WAPE over the elapsed horizon
  bias numeric(10,4),                                  -- mean signed error / mean actual (over-forecast +)
  fit_wape numeric(10,4),                              -- the fit-time baseline it is judged against
  model text,
  sample_n integer,                                    -- # of horizon days with an actual observation
  degraded boolean NOT NULL DEFAULT false,             -- sustained realized WAPE above the baseline
  run_id bigint,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_accuracy_history_tenant ON scm_accuracy_history (tenant_id, branch_id, item_id, as_of_date);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
--
-- EXCLUDES `audit_expectations` (migration 0465): its tenant_isolation policy is DELIBERATELY permissive —
-- re-scoping it here 500s every god act-as mutation (25P02; see CLAUDE.md + migration 0470). Keep this
-- exclusion in any migration that copies this loop.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name <> 'audit_expectations' LOOP
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

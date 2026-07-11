-- 0346_flux_analysis — CLS-01 (GL-25): Flux / variance analysis with forced explanation + sign-off. A SOX
-- management-review control over the period close. A preparer GENERATES a period-over-period (or vs
-- prior-year / vs budget) P&L or BS movement analysis from gl_period_balances; each line's Δ$ / Δ% is tested
-- against configurable thresholds (absolute + %). A threshold-BREACHING line REQUIRES a written explanation
-- before the analysis can be signed off; an INDEPENDENT reviewer (≠ preparer) then certifies. Posts NOTHING
-- to the GL — a read-only aggregator over the posting snapshot + these two governance tables.
--
-- Two tenant-scoped tables: a leading (tenant_id, …) index on each + the CANONICAL 0232-form
-- tenant_isolation RLS policy (re-applied via the generic DO-loop below) + app_user grants. Idempotent;
-- PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS flux_analyses (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  period text NOT NULL,                          -- 'YYYY-MM'
  basis text NOT NULL DEFAULT 'PL',              -- 'PL' (P&L) | 'BS' (balance sheet)
  comparative text NOT NULL DEFAULT 'prior_period', -- 'prior_period' | 'prior_year' | 'budget'
  comparative_period text,                       -- resolved comparative label (YYYY-MM or 'budget')
  threshold_abs numeric(18,2) NOT NULL DEFAULT 10000,
  threshold_pct numeric(9,2) NOT NULL DEFAULT 10,
  status text NOT NULL DEFAULT 'Draft',          -- 'Draft' | 'Explained' | 'Certified'
  breached_count integer NOT NULL DEFAULT 0,
  explained_count integer NOT NULL DEFAULT 0,
  prepared_by text,
  prepared_at timestamptz DEFAULT now(),
  reviewed_by text,
  reviewed_at timestamptz,
  note text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS flux_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  analysis_id bigint NOT NULL REFERENCES flux_analyses(id),
  account_code text NOT NULL,
  account_name text,
  account_type text,
  current_amt numeric(18,2) NOT NULL DEFAULT 0,
  comparative_amt numeric(18,2) NOT NULL DEFAULT 0,
  delta_amt numeric(18,2) NOT NULL DEFAULT 0,
  delta_pct numeric(9,2),
  breached boolean NOT NULL DEFAULT false,
  explanation text,
  explained_by text,
  explained_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_flux_analyses_tenant ON flux_analyses (tenant_id, period);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_flux_lines_tenant ON flux_lines (tenant_id, analysis_id);
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

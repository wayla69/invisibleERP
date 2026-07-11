-- 0346_dta_valuation_allowance_utp — TAX-12: DTA valuation allowance + Uncertain Tax Positions (FIN 48) register.
-- Two ASC 740 income-tax disclosures that ride ON TOP of the deferred-tax engine (TAX-06, deferred_tax_runs):
--   • dta_valuation_allowances — a more-likely-than-not (MLTN) recoverability assessment on the GROSS deferred
--     tax asset. allowance = max(0, dta_gross − mltn_recoverable). A maker-checker run→post lifecycle (one row
--     per tenant/period): the 'Open' row is posted (poster ≠ runner) as the DELTA vs the prior posted allowance
--     to the contra-DTA / deferred-tax-expense accounts (Dr 5950 / Cr 1700 when the allowance increases;
--     reversed when it releases), so the net DTA carried on the balance sheet is the recoverable portion.
--   • uncertain_tax_positions — a FIN 48 (ASC 740-10) MEMO register: position, tax year, gross exposure, the
--     recognized (MLTN-sustainable) benefit, the unrecognized reserve, and any interest/penalty accrual. No GL
--     leg (the reserve is a disclosure). Maker-checker on create/settle (settler ≠ creator). Open|Settled|Lapsed.
-- Both tables are tenant-scoped: a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation RLS
-- policy (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS dta_valuation_allowances (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  period text NOT NULL,                                     -- 'YYYY-MM'
  as_of_date date NOT NULL,
  dta_gross numeric(18,4) NOT NULL DEFAULT 0,               -- gross DTA (from TAX-06 deferred_tax_runs, or supplied)
  mltn_recoverable numeric(18,4) NOT NULL DEFAULT 0,        -- MLTN-recoverable portion (management judgment)
  allowance numeric(18,4) NOT NULL DEFAULT 0,               -- max(0, dta_gross − mltn_recoverable)
  delta_posted numeric(18,4) NOT NULL DEFAULT 0,            -- Δ vs the prior posted allowance
  status text NOT NULL DEFAULT 'Open',                      -- 'Open' | 'Posted'
  posted_entry_id bigint,
  basis text,                                               -- MLTN assessment rationale (optional)
  run_by text,
  posted_by text,
  posted_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_dta_va_period ON dta_valuation_allowances (tenant_id, period);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_dta_va_tenant ON dta_valuation_allowances (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS uncertain_tax_positions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  position_no text NOT NULL,                                -- UTP-YYYYMMDD-NNN
  tax_year integer NOT NULL,
  description text NOT NULL,
  gross_exposure numeric(18,4) NOT NULL DEFAULT 0,          -- total tax at risk
  recognized_benefit numeric(18,4) NOT NULL DEFAULT 0,      -- MLTN-sustainable benefit recognized
  reserve numeric(18,4) NOT NULL DEFAULT 0,                 -- unrecognized tax benefit (gross_exposure − recognized_benefit)
  interest_penalty numeric(18,4) NOT NULL DEFAULT 0,        -- accrued interest + penalty on the position
  status text NOT NULL DEFAULT 'Open',                      -- 'Open' | 'Settled' | 'Lapsed'
  settlement_amount numeric(18,4),
  settlement_note text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  settled_by text,
  settled_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_utp_no ON uncertain_tax_positions (tenant_id, position_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_utp_tenant ON uncertain_tax_positions (tenant_id, status);
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

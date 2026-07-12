-- 0359_revrec_variable_estimates — Track D Wave 2 (control REV-25): variable consideration + the constraint
-- under TFRS 15 / IFRS 15 / ASC 606 §50-59. The REV-19 engine holds a FIXED transaction price
-- (rev_contracts.total_price). A contract with variable consideration (rebates, refunds, performance
-- bonuses/penalties, price concessions, usage tiers) must ESTIMATE the variable amount (expected value OR
-- most-likely amount), CONSTRAIN it to the portion highly probable NOT to reverse, re-estimate each period,
-- and TRUE-UP already-recognized revenue via a cumulative catch-up. Each estimate is a management judgement:
-- it is a maker-checker artifact (estimator ≠ approver) and only the CONSTRAINED amount (never the gross
-- estimate) is added to the recognizable transaction price. All GL routes through LedgerService.postEntry so
-- the period lock (PERIOD_LOCKED) + GL-17 audit bind. No new COA (2410/1265/4300 already exist + CF-classified).
--
-- rev_variable_estimates — the per-contract, per-period estimate register (tenant-scoped, leading
-- (tenant_id, contract_id) index + the CANONICAL 0232-form tenant_isolation RLS policy + app_user grants).

CREATE TABLE IF NOT EXISTS rev_variable_estimates (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  contract_id bigint NOT NULL REFERENCES rev_contracts(id),
  as_of text NOT NULL,
  method text NOT NULL,
  gross_estimate numeric(18,4) NOT NULL,
  constrained_amount numeric(18,4) NOT NULL,
  posted_delta numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'Pending',
  note text,
  created_by text,
  approved_by text,
  applied_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rev_var_est_tenant ON rev_variable_estimates (tenant_id, contract_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rev_var_est_status ON rev_variable_estimates (tenant_id, status);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new table
-- gets RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

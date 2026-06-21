-- Phase 14 — Accounting Tier 3: Budget vs Actual (งบประมาณเทียบจริง). Reference data, no GL effect.
-- (cost_centers + journal_lines.cost_center_code already exist from 0016.)
CREATE TABLE IF NOT EXISTS budgets (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  fiscal_year integer NOT NULL,
  account_code text NOT NULL,
  cost_center_code text,
  period text NOT NULL,                 -- 'YYYY-MM'
  amount numeric(18,4) NOT NULL DEFAULT 0,
  notes text, created_by text,
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budget_account ON budgets(account_code, period);
-- Upsert keys: two partial unique indexes so a NULL cost_center collapses to one tenant-wide row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_line_cc ON budgets (tenant_id, fiscal_year, account_code, cost_center_code, period) WHERE cost_center_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_line_nocc ON budgets (tenant_id, fiscal_year, account_code, period) WHERE cost_center_code IS NULL;

-- Re-run the 0002 RLS loop so budgets (tenant_id) is isolation-scoped.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)', r.table_name);
  END LOOP;
END $$;

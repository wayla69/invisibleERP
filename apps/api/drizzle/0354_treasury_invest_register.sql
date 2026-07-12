-- 0354_treasury_invest_register — Track C Wave 2: Investment & Securities register (control TRE-03). Builds the
-- reusable OCI-reserve primitive (Wave 3 hedge accounting reuses it). A security is bought under maker-checker
-- (create → PendingApproval; a DIFFERENT user approves → the buy posts Dr 1350|1360|1370 per classification /
-- Cr 1010 Bank; self-approve → SOD_SELF_APPROVAL). Classification = AMORTIZED_COST (EIR interest income, reusing
-- the Wave-1 amortized-cost engine) | FVOCI (mark-to-market through the OCI equity RESERVE 3500) | FVTPL (MTM
-- through P&L 5430). A maker-checker market-PRICE register (investment_prices, mirroring fx_rates / FX-04) drives
-- MTM — an unapproved price can never revalue. ECL impairment posts Dr 5440 / Cr 1355 allowance (contra-asset).
--
-- Three tenant-scoped tables — each with a leading (tenant_id, …) index + the CANONICAL 0232-form
-- tenant_isolation RLS policy (re-applied via the generic DO-loop below) + app_user grants. Also registers the
-- INVEST.* posting-event types for /setup/posting-rules. Idempotent; PGlite + Postgres alike. (No new role_enum
-- values — the Wave-1 treasury/treasury_approve duties + TreasuryAnalyst/TreasuryManager roles are reused.)

CREATE TABLE IF NOT EXISTS investments (
  id bigserial PRIMARY KEY,
  investment_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  instrument text NOT NULL,
  instrument_type text NOT NULL DEFAULT 'bond',
  symbol text,
  classification text NOT NULL DEFAULT 'AMORTIZED_COST',
  currency text NOT NULL DEFAULT 'THB',
  quantity numeric(18,4) NOT NULL DEFAULT 1,
  cost numeric(18,2) NOT NULL DEFAULT 0,
  eir_pct numeric(9,6) NOT NULL DEFAULT 0,
  trade_date date,
  maturity_date date,
  carrying_value numeric(18,2) NOT NULL DEFAULT 0,
  allowance numeric(18,2) NOT NULL DEFAULT 0,
  fvoci_reserve numeric(18,2) NOT NULL DEFAULT 0,
  accrued_income numeric(18,2) NOT NULL DEFAULT 0,
  periods_posted integer NOT NULL DEFAULT 0,
  next_run_date date,
  status text NOT NULL DEFAULT 'PendingApproval',
  entry_no text,
  requested_by text,
  approved_by text,
  approved_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_investments_tenant ON investments (tenant_id, classification, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS investment_prices (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  symbol text NOT NULL,
  price_date date NOT NULL,
  price numeric(18,6) NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'PendingApproval',
  requested_by text,
  approved_by text,
  approved_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_investment_prices_tenant ON investment_prices (tenant_id, symbol, price_date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS investment_valuations (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  investment_id bigint REFERENCES investments(id),
  as_of date,
  val_type text NOT NULL DEFAULT 'MTM',
  price numeric(18,6),
  prior_carrying numeric(18,2) NOT NULL DEFAULT 0,
  new_carrying numeric(18,2) NOT NULL DEFAULT 0,
  delta numeric(18,2) NOT NULL DEFAULT 0,
  oci_delta numeric(18,2) NOT NULL DEFAULT 0,
  pl_delta numeric(18,2) NOT NULL DEFAULT 0,
  allowance_delta numeric(18,2) NOT NULL DEFAULT 0,
  entry_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_investment_valuations_tenant ON investment_valuations (tenant_id, investment_id, as_of);
--> statement-breakpoint
-- Register the posting-event types (governed on /setup/posting-rules; the registry in posting-events.ts is the
-- code-side source of truth). Idempotent.
INSERT INTO posting_event_types (key, name, description) VALUES
  ('INVEST.BUY', 'Investment purchase', 'Buy a security — Dr 1350|1360|1370 class asset / Cr 1010 Bank (TRE-03)'),
  ('INVEST.INCOME', 'Investment income', 'Interest (amortized-cost EIR) or dividend / Cr 4700 Investment Income (TRE-03)'),
  ('INVEST.MTM.PL', 'Investment MTM — FVTPL (P&L)', 'Mark-to-market a FVTPL holding through P&L 5430 from an approved price (TRE-03)'),
  ('INVEST.MTM.OCI', 'Investment MTM — FVOCI (OCI)', 'Mark-to-market a FVOCI holding through the OCI reserve 3500 from an approved price (TRE-03)'),
  ('INVEST.IMPAIR', 'Investment ECL impairment', 'ECL impairment — Dr 5440 Investment Impairment / Cr 1355 Allowance (TRE-03)')
ON CONFLICT (key) DO NOTHING;
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

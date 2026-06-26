-- WS3.2 — Deferred tax (TAX-06) + FX revaluation governance (GL-18).
-- Two period-scoped, idempotent run tables that wrap the year-end-close numerics in a maker-checker
-- run→post lifecycle (compute as 'Open', a DIFFERENT user posts → 'Posted'), one row per (tenant, period).
--   * fx_reval_runs    — period-end revaluation of foreign-currency monetary balances (open AR/AP in a
--                        non-functional currency) to the closing rate → unrealized FX gain/loss (5400).
--   * deferred_tax_runs — book-vs-tax temporary differences (AR allowance, accelerated depreciation) ×
--                        the CIT rate → deferred tax asset (1700) / liability (2700) / expense (5950).
-- The COA accounts 1700/2700/5950 are seeded via seedChartOfAccounts (the COA constant in ledger.service.ts);
-- 5400 (FX Gain/Loss unrealized) already exists. Posting goes through LedgerService.postEntry so the WS2.1
-- PERIOD_LOCKED gate + WS2.2 GL audit trail apply.
CREATE TABLE IF NOT EXISTS fx_reval_runs (
  id              bigserial PRIMARY KEY,
  tenant_id       bigint REFERENCES tenants(id),
  period          text NOT NULL,                       -- 'YYYY-MM'
  as_of_date      date NOT NULL,                        -- closing date the reval is struck at (period end)
  status          text NOT NULL DEFAULT 'Open',         -- 'Open' | 'Posted'
  rates           jsonb,                                -- {currency: closing rate THB-per-unit} actually used
  total_gain      numeric(18,4) NOT NULL DEFAULT 0,
  total_loss      numeric(18,4) NOT NULL DEFAULT 0,
  net             numeric(18,4) NOT NULL DEFAULT 0,     -- +ve = net gain, -ve = net loss (P&L sign)
  posted_entry_id bigint,
  detail          jsonb,                                -- [{ scope, currency, open_foreign, booked_rate, closing_rate, delta }]
  run_by          text,
  posted_by       text,
  posted_at       timestamptz,
  created_at      timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_fx_reval_runs_period ON fx_reval_runs (tenant_id, period);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS deferred_tax_runs (
  id               bigserial PRIMARY KEY,
  tenant_id        bigint REFERENCES tenants(id),
  period           text NOT NULL,                       -- 'YYYY-MM'
  as_of_date       date NOT NULL,
  tax_rate         numeric(9,6) NOT NULL DEFAULT 0.20,  -- Thai CIT 20%
  temp_differences jsonb,                               -- [{ name, bookBasis, taxBasis, difference, dtAssetOrLiab }]
  dta              numeric(18,4) NOT NULL DEFAULT 0,     -- deferred tax ASSET (deductible temp diffs × rate)
  dtl              numeric(18,4) NOT NULL DEFAULT 0,     -- deferred tax LIABILITY (taxable temp diffs × rate)
  net_deferred     numeric(18,4) NOT NULL DEFAULT 0,     -- dta − dtl (+ve = net asset)
  delta_posted     numeric(18,4) NOT NULL DEFAULT 0,     -- change in net_deferred vs the prior posted run
  status           text NOT NULL DEFAULT 'Open',         -- 'Open' | 'Posted'
  posted_entry_id  bigint,
  run_by           text,
  posted_by        text,
  posted_at        timestamptz,
  created_at       timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_deferred_tax_runs_period ON deferred_tax_runs (tenant_id, period);
--> statement-breakpoint
-- Re-run the RLS loop so the two new tenant_id tables are isolation-scoped (idempotent — DROP POLICY IF EXISTS).
-- WITH CHECK + the app.bypass_rls escape mirror 0163/0167 so an HQ/Admin (bypass) close run can post the
-- group-level FX reval / deferred tax cross-tenant.
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

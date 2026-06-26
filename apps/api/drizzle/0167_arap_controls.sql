-- WS2.3 — AR allowance for doubtful accounts (ECL, REV-18). A periodic, aging-driven allowance computation
-- (Dr 5720 Bad-Debt Expense / Cr 1190 Allowance for Doubtful Accounts) posted as the DELTA vs the prior
-- posted allowance, under maker-checker SoD (computer ≠ poster). One allowance row per (tenant, as_of_date).
-- Credit limit/hold (REV-12/REV-17) and the AP 3-way-match payment gate (AP-03) are already modelled
-- (tenants.credit_limit/credit_hold; invoice_match_results + match_tolerance) — this migration adds only the
-- allowance sub-ledger table. The 1190 contra-asset account is seeded via seedChartOfAccounts (COA constant).
CREATE TABLE IF NOT EXISTS ar_allowance (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  as_of_date date NOT NULL,
  method text NOT NULL DEFAULT 'aging',          -- 'aging' | 'percentage'
  total_ar numeric(18,4) NOT NULL DEFAULT 0,
  allowance numeric(18,4) NOT NULL DEFAULT 0,
  buckets jsonb,                                  -- [{bucket, outstanding, rate, provision}]
  posted boolean NOT NULL DEFAULT false,
  posted_entry_id bigint,
  posted_amount numeric(18,4),                    -- the delta actually journalled (signed)
  computed_by text,
  posted_by text,
  created_at timestamptz DEFAULT now(),
  posted_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_ar_allowance_asof ON ar_allowance (tenant_id, as_of_date);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id table is isolation-scoped (idempotent — DROP POLICY IF EXISTS).
-- WITH CHECK + the app.bypass_rls escape mirror 0151/0163 so an HQ/Admin (bypass) allowance run can post
-- cross-tenant when computing the group allowance.
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

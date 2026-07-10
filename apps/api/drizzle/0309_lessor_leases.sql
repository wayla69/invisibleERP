-- 0309_lessor_leases — Lessor-side lease accounting (IFRS 16 / TFRS 16 lessor) — control LSE-02 (FIN-10).
-- Extends the existing lessee engine (LSE-01, table `leases`) with the LESSOR side. Each lease is classified
-- at commencement as a FINANCE or an OPERATING lease per the IFRS 16 lessor criteria (transfer of ownership /
-- bargain purchase / lease term a major part of the asset's economic life / PV of the payments ≈ fair value).
-- Classification + commencement is maker-checker: the row is created 'pending' and a DIFFERENT user approves
-- it (SoD) before any GL posts.
--   FINANCE lease: at approval the lessor DERECOGNISES the underlying asset (Cr 1500) and books a NET
--   INVESTMENT IN LEASE / lease receivable at the PV of the payments (Dr 1610), selling profit/loss to 1510;
--   each periodic run recognises INTEREST INCOME (Cr 4600) on the running receivable and collects the cash
--   (Dr 1000), reducing the receivable by the principal portion.
--   OPERATING lease: the lessor KEEPS the asset, recognises STRAIGHT-LINE RENTAL INCOME (Dr 1000 / Cr 4610)
--   and CONTINUES DEPRECIATING the asset (Dr 5200 / Cr 1590) over its economic life.
CREATE TABLE IF NOT EXISTS lessor_leases (
  id bigserial PRIMARY KEY,
  lease_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  lessee text,
  start_date date,
  term_months bigint NOT NULL,
  monthly_payment numeric(14,2) NOT NULL,
  annual_rate_pct numeric(8,4) NOT NULL DEFAULT '0',
  asset_cost numeric(14,2) NOT NULL DEFAULT '0',
  fair_value numeric(14,2) DEFAULT '0',
  economic_life_months bigint,
  transfer_ownership boolean NOT NULL DEFAULT false,
  bargain_purchase boolean NOT NULL DEFAULT false,
  classification text NOT NULL,
  net_investment numeric(14,2) DEFAULT '0',
  receivable_balance numeric(14,2) DEFAULT '0',
  interest_income_recognized numeric(14,2) DEFAULT '0',
  accumulated_dep numeric(14,2) DEFAULT '0',
  rental_income_recognized numeric(14,2) DEFAULT '0',
  periods_posted bigint DEFAULT 0,
  next_run_date date,
  status text NOT NULL DEFAULT 'pending',
  created_by text,
  approved_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lessor_lease_due ON lessor_leases (status, next_run_date);
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

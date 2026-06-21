-- Phase 15 — Accounting Tier 3 batch 2: FX Revaluation (ตีราคาอัตราแลกเปลี่ยน).
-- Period-end revaluation of open foreign-currency monetary balances → unrealized FX gain/loss (5400 seeded in code).
-- AP booked rate (AR already has ar_invoices.fx_rate; AP did not).
ALTER TABLE ap_transactions ADD COLUMN IF NOT EXISTS fx_rate numeric(18,8) DEFAULT 1;

CREATE TABLE IF NOT EXISTS fx_rates (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  currency text NOT NULL,
  rate_date date NOT NULL,
  rate numeric(18,8) NOT NULL,
  source text DEFAULT 'manual',
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fxrate_lookup ON fx_rates(currency, rate_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fxrate_tenant ON fx_rates (tenant_id, currency, rate_date) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fxrate_shared ON fx_rates (currency, rate_date) WHERE tenant_id IS NULL;

-- Re-run the 0002 RLS loop so fx_rates (tenant_id) is isolation-scoped.
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

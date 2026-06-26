-- B3 — Tip pooling / distribution (TIP-01). Tips ride into 2300 Tips Payable on checkout (a staff
-- pass-through liability). A distribution pays the pooled tips out to staff for a period — Dr 2300 /
-- Cr 1000 — clearing the liability; it can never exceed the available pool (collected − already
-- distributed), so tips can't be over-paid and 2300 always reconciles to outstanding.
CREATE TABLE IF NOT EXISTS tip_distributions (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  dist_no text NOT NULL,
  period_from text NOT NULL,
  period_to text NOT NULL,
  method text NOT NULL DEFAULT 'equal',
  pool_amount numeric(18,4) NOT NULL,
  pay_account text NOT NULL DEFAULT '1000',
  journal_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tip_distribution_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  dist_id bigint NOT NULL REFERENCES tip_distributions(id),
  staff text NOT NULL,
  basis numeric(18,4) NOT NULL DEFAULT 0,
  share numeric(9,6) NOT NULL DEFAULT 0,
  amount numeric(18,4) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tip_dist_period ON tip_distributions (tenant_id, period_from, period_to);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id tables are isolation-scoped (idempotent — DROP POLICY IF EXISTS).
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

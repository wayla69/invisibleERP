-- 0120 — ERP gap pack: petty-cash advances (EXP-07), prepaid amortization (GL-09), lease accounting
-- IFRS 16 (LSE-01), asset revaluation/impairment (FA-07). New tenant_id tables → RLS loop re-run.
CREATE TABLE IF NOT EXISTS employee_advances (
  id bigserial PRIMARY KEY,
  advance_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  payee text NOT NULL,
  purpose text,
  amount numeric(14,2) NOT NULL,
  status text NOT NULL DEFAULT 'open',
  expense_account text DEFAULT '5100',
  settled_expense numeric(14,2) DEFAULT 0,
  returned_cash numeric(14,2) DEFAULT 0,
  issued_by text,
  issued_date date,
  settled_by text,
  settled_date date,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_adv_status ON employee_advances (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS prepaid_schedules (
  id bigserial PRIMARY KEY,
  schedule_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  total_amount numeric(14,2) NOT NULL,
  months bigint NOT NULL,
  amortized_amount numeric(14,2) DEFAULT 0,
  periods_posted bigint DEFAULT 0,
  expense_account text DEFAULT '5100',
  prepaid_account text DEFAULT '1280',
  start_date date,
  next_run_date date,
  status text NOT NULL DEFAULT 'active',
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_prepaid_due ON prepaid_schedules (status, next_run_date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS leases (
  id bigserial PRIMARY KEY,
  lease_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  lessor text,
  start_date date,
  term_months bigint NOT NULL,
  monthly_payment numeric(14,2) NOT NULL,
  annual_rate_pct numeric(8,4) NOT NULL DEFAULT 0,
  initial_liability numeric(14,2) DEFAULT 0,
  liability_balance numeric(14,2) DEFAULT 0,
  accumulated_dep numeric(14,2) DEFAULT 0,
  periods_posted bigint DEFAULT 0,
  next_run_date date,
  status text NOT NULL DEFAULT 'active',
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lease_due ON leases (status, next_run_date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS asset_revaluations (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  asset_id bigint REFERENCES fixed_assets(id),
  asset_no text,
  reval_date date,
  kind text NOT NULL,
  old_value numeric(18,4) NOT NULL,
  new_value numeric(18,4) NOT NULL,
  delta numeric(18,4) NOT NULL,
  reason text,
  gl_ref text,
  actioned_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_reval_asset ON asset_revaluations (asset_no);
--> statement-breakpoint
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

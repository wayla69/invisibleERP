-- 0321_hcm_leave_accrual — HR-2 (docs/42): leave accrual engine + policies (control HR-02).
-- New tenant tables: leave_types (accrual method + caps), leave_policies (rate override by grade/tenure),
-- leave_accrual_runs (idempotent per tenant+period). Extends leave_balances with accrued/carryover/expired
-- (balance = entitled+accrued+carryover-used-expired) and employees with job_grade (drives policy overrides).
-- Each new tenant table gets a leading (tenant_id,…) index + the CANONICAL 0232-form RLS DO-loop below.
CREATE TABLE IF NOT EXISTS leave_types (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  accrual_method text NOT NULL DEFAULT 'none',        -- monthly | anniversary | none
  accrual_rate_days numeric(8,4) NOT NULL DEFAULT 0,  -- days accrued per period
  carryover_cap_days numeric(8,2) NOT NULL DEFAULT 0, -- max days rolled to next year
  max_balance_days numeric(8,2) NOT NULL DEFAULT 0,   -- hard cap on total balance (0 = uncapped)
  allow_negative boolean NOT NULL DEFAULT false,      -- relax the entitlement gate
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leave_types_tenant ON leave_types (tenant_id, code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS leave_policies (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  leave_type_id bigint NOT NULL REFERENCES leave_types(id),
  job_grade text,
  min_tenure_months integer NOT NULL DEFAULT 0,
  accrual_rate_days numeric(8,4) NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leave_policies_tenant ON leave_policies (tenant_id, leave_type_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS leave_accrual_runs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  period text NOT NULL,                               -- YYYY-MM
  run_at timestamptz DEFAULT now(),
  accrued_total numeric(12,2) NOT NULL DEFAULT 0,
  employees_count integer NOT NULL DEFAULT 0,
  run_by text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leave_accrual_runs_tenant ON leave_accrual_runs (tenant_id, period);
--> statement-breakpoint
-- Extend leave_balances with the accrual columns (idempotent). balance = entitled+accrued+carryover-used-expired.
ALTER TABLE leave_balances ADD COLUMN IF NOT EXISTS leave_type_code text;
--> statement-breakpoint
ALTER TABLE leave_balances ADD COLUMN IF NOT EXISTS accrued numeric(8,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE leave_balances ADD COLUMN IF NOT EXISTS carryover numeric(8,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE leave_balances ADD COLUMN IF NOT EXISTS expired numeric(8,2) DEFAULT 0;
--> statement-breakpoint
-- Employee job grade drives the leave-accrual policy override (nullable; NULL policy applies to any grade).
ALTER TABLE employees ADD COLUMN IF NOT EXISTS job_grade text;
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

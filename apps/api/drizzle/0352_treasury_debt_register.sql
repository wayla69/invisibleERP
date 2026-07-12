-- 0352_treasury_debt_register — Track C Wave 1: Debt & Borrowings register (controls TRE-01 + TRE-02). A
-- reusable EIR/amortized-cost engine (Waves 2 & 4 depend on it): debt facilities under maker-checker
-- (create → PendingApproval; a DIFFERENT user approves → Approved; self-approve → SOD_SELF_APPROVAL), drawdowns
-- that book principal to the short-/long-term borrowings control (Dr 1010 Bank / Cr 2500|2550), an idempotent
-- effective-interest amortized-cost accrual on each drawdown's carrying amount (Dr 5900 / Cr 2450, mirroring
-- the lease interest-unwind LSE-01), a maturity ladder, and covenant tracking + breach detection (TRE-02).
--
-- Four tenant-scoped tables — each with a leading (tenant_id, …) index + the CANONICAL 0232-form
-- tenant_isolation RLS policy (re-applied via the generic DO-loop below) + app_user grants. Also registers the
-- DEBT.* posting-event types for /setup/posting-rules and adds the treasury single-duty roles to role_enum.
-- Idempotent; PGlite + Postgres alike.

-- Treasury single-duty roles (maker analyst + checker manager). ADD VALUE IF NOT EXISTS is idempotent (PG 12+).
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'TreasuryAnalyst';
--> statement-breakpoint
ALTER TYPE "role_enum" ADD VALUE IF NOT EXISTS 'TreasuryManager';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS debt_facilities (
  id bigserial PRIMARY KEY,
  facility_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  lender text,
  currency text NOT NULL DEFAULT 'THB',
  facility_type text NOT NULL DEFAULT 'long_term',
  limit_amount numeric(18,2) NOT NULL DEFAULT 0,
  eir_pct numeric(9,6) NOT NULL DEFAULT 0,
  start_date date,
  maturity_date date,
  status text NOT NULL DEFAULT 'PendingApproval',
  drawn_amount numeric(18,2) NOT NULL DEFAULT 0,
  outstanding_principal numeric(18,2) NOT NULL DEFAULT 0,
  requested_by text,
  approved_by text,
  approved_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_debt_facilities_tenant ON debt_facilities (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS debt_drawdowns (
  id bigserial PRIMARY KEY,
  drawdown_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  facility_id bigint REFERENCES debt_facilities(id),
  drawdown_date date,
  principal numeric(18,2) NOT NULL DEFAULT 0,
  rate_pct numeric(9,6) NOT NULL DEFAULT 0,
  amortized_cost numeric(18,2) NOT NULL DEFAULT 0,
  accrued_interest numeric(18,2) NOT NULL DEFAULT 0,
  periods_posted integer NOT NULL DEFAULT 0,
  next_run_date date,
  status text NOT NULL DEFAULT 'active',
  entry_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_debt_drawdowns_tenant ON debt_drawdowns (tenant_id, facility_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS debt_covenants (
  id bigserial PRIMARY KEY,
  covenant_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  facility_id bigint REFERENCES debt_facilities(id),
  name text NOT NULL,
  metric text NOT NULL,
  operator text NOT NULL DEFAULT 'gte',
  threshold numeric(18,6) NOT NULL DEFAULT 0,
  cadence text NOT NULL DEFAULT 'quarterly',
  status text NOT NULL DEFAULT 'active',
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_debt_covenants_tenant ON debt_covenants (tenant_id, facility_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS debt_covenant_tests (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  covenant_id bigint REFERENCES debt_covenants(id),
  facility_id bigint REFERENCES debt_facilities(id),
  as_of date,
  metric text,
  operator text,
  threshold numeric(18,6) NOT NULL DEFAULT 0,
  actual_value numeric(18,6) NOT NULL DEFAULT 0,
  breached boolean NOT NULL DEFAULT false,
  note text,
  tested_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_debt_covenant_tests_tenant ON debt_covenant_tests (tenant_id, covenant_id, breached);
--> statement-breakpoint
-- Register the posting-event types (governed on /setup/posting-rules; the registry in posting-events.ts is the
-- code-side source of truth). Idempotent.
INSERT INTO posting_event_types (key, name, description) VALUES
  ('DEBT.DRAWDOWN', 'Borrowing drawdown', 'Facility drawdown — Dr 1010 Bank / Cr 2500|2550 Borrowings (TRE-01)'),
  ('DEBT.INTEREST', 'Borrowing EIR interest accrual', 'Effective-interest accrual — Dr 5900 Interest Expense / Cr 2450 Accrued Interest Payable (TRE-01)'),
  ('DEBT.REPAY', 'Borrowing repayment', 'Repay principal + accrued interest — Dr 2500|2550 + Dr 2450 / Cr 1010 Bank (TRE-01)')
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

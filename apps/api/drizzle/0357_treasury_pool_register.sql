-- 0357_treasury_pool_register — Track C Wave 4 (FINAL): Cash pooling / in-house bank / intercompany-loan register
-- (control TRE-05). Three surfaces on one spine:
--   • CASH POOL (notional | physical) — a header (master) account with member sub-accounts (in-house bank). A
--     PHYSICAL pool SWEEPS cash member→header (Dr header-bank / Cr member-bank); a NOTIONAL pool ALLOCATES the
--     pooled interest across members, an allocation that MUST sum to zero (surplus members earn 4700 income,
--     deficit members bear 5900 expense; group net P&L = 0 — the zero-sum IS the control).
--   • IC LOAN register — maker-checker (register → PendingApproval; a DIFFERENT user approves → the mirrored
--     drawdown posts Dr 1155 IC-Loan Receivable (creditor) / Cr 1010 Bank AND Dr 1010 Bank / Cr 2155 IC-Loan
--     Payable (debtor); self-approve → SOD_SELF_APPROVAL). EIR interest accrues Dr 1155 / Cr 4700 (creditor) and
--     Dr 5900 / Cr 2155 (debtor). THE CONTROL CORE: on consolidation the 1155/2155 pair AND the 4700/5900 IC
--     interest ELIMINATE (mirroring the 1150/2150 trade-IC pair) so group balances + finance cost/income → 0.
-- The ic_loans row's tenant_id = the CREDITOR side (mirrors ic_transactions scoping → creditor is the RLS owner).
--
-- Four tenant-scoped tables — each with a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation
-- RLS policy (re-applied via the generic DO-loop below) + app_user grants. Also registers the ICLOAN.*/POOL.*
-- posting-event types for /setup/posting-rules. Idempotent; PGlite + Postgres alike. (No new role_enum values —
-- the Wave-1 treasury/treasury_approve duties are reused.)

CREATE TABLE IF NOT EXISTS cash_pools (
  id bigserial PRIMARY KEY,
  pool_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  pool_type text NOT NULL DEFAULT 'notional',
  header_account text NOT NULL,
  currency text NOT NULL DEFAULT 'THB',
  status text NOT NULL DEFAULT 'active',
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cash_pools_tenant ON cash_pools (tenant_id, pool_type, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cash_pool_members (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  pool_id bigint REFERENCES cash_pools(id),
  member_tenant_id bigint REFERENCES tenants(id),
  member_account text NOT NULL,
  cap numeric(18,2) NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cash_pool_members_tenant ON cash_pool_members (tenant_id, pool_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ic_loans (
  id bigserial PRIMARY KEY,
  loan_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  creditor_tenant_id bigint NOT NULL REFERENCES tenants(id),
  debtor_tenant_id bigint NOT NULL REFERENCES tenants(id),
  principal numeric(18,2) NOT NULL DEFAULT 0,
  eir_pct numeric(9,6) NOT NULL DEFAULT 0,
  carrying numeric(18,2) NOT NULL DEFAULT 0,
  accrued_interest numeric(18,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'THB',
  start_date date,
  next_run_date date,
  periods_posted integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'PendingApproval',
  creditor_entry_no text,
  debtor_entry_no text,
  requested_by text,
  approved_by text,
  approved_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ic_loans_tenant ON ic_loans (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ic_loan_accruals (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  loan_id bigint REFERENCES ic_loans(id),
  as_of date,
  period text,
  interest numeric(18,2) NOT NULL DEFAULT 0,
  creditor_entry_no text,
  debtor_entry_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ic_loan_accruals_tenant ON ic_loan_accruals (tenant_id, loan_id, as_of);
--> statement-breakpoint
-- Register the posting-event types (governed on /setup/posting-rules; the registry in posting-events.ts is the
-- code-side source of truth). Idempotent.
INSERT INTO posting_event_types (key, name, description) VALUES
  ('ICLOAN.DRAWDOWN', 'Intercompany loan drawdown', 'Mirrored IC-loan drawdown — creditor Dr 1155 IC-Loan Receivable / Cr 1010 Bank; debtor Dr 1010 Bank / Cr 2155 IC-Loan Payable (the 1155/2155 pair eliminates on consolidation) (TRE-05)'),
  ('ICLOAN.INTEREST', 'Intercompany loan EIR interest', 'Mirrored EIR interest accrual on the amortized cost — creditor Dr 1155 / Cr 4700 Investment/Interest Income; debtor Dr 5900 Interest Expense / Cr 2155 (the 4700/5900 IC interest eliminates on consolidation) (TRE-05)'),
  ('POOL.SWEEP', 'Cash pool physical sweep', 'Physical cash-pool sweep member->header — Dr header-bank / Cr member-bank (in-house-bank concentration) (TRE-05)'),
  ('POOL.INTEREST', 'Cash pool notional interest', 'Notional cash-pool interest allocation across members — a zero-sum redistribution (surplus members Cr 4700 income, deficit members Dr 5900 expense; sum = 0) (TRE-05)')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new tables get
-- RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

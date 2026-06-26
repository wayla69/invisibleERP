-- 0143 — Petty cash imprest float + direct-expense / advance maker-checker with document tracking (EXP-08).
-- A petty_cash_fund holds an imprest float capped at a credit limit (วงเงิน); its balance is the cash on hand.
-- An expense_request draws against a fund as either a direct EXPENSE or an ADVANCE: it is a maker-checker
-- REQUEST that posts NOTHING and reserves nothing until a DIFFERENT user approves. On approval the GL posts
-- (expense: Dr <expense acct> / Cr 1015 petty cash; advance: Dr 1180 employee advances / Cr 1015) and the
-- fund balance is decremented; a draw cannot exceed the fund's available balance. Advances later settle
-- (Dr expense + Dr 1015 returned / Cr 1180), returning unused cash to the fund. Every request carries a
-- document reference + receipt key and a status trail (StatusLog) for end-to-end document tracking.

CREATE TABLE IF NOT EXISTS petty_cash_funds (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  fund_code text NOT NULL,
  name text,
  custodian text,
  department text,
  gl_account text NOT NULL DEFAULT '1015',          -- petty-cash control account
  float_limit numeric(14,2) NOT NULL DEFAULT 0,      -- วงเงิน — the imprest ceiling
  balance numeric(14,2) NOT NULL DEFAULT 0,          -- cash currently on hand in the fund
  status text NOT NULL DEFAULT 'active',             -- active | closed
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_petty_fund_code ON petty_cash_funds (tenant_id, fund_code);

CREATE TABLE IF NOT EXISTS expense_requests (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  req_no text NOT NULL,                              -- PEX-YYYYMMDD-NNN
  fund_id bigint REFERENCES petty_cash_funds(id),
  kind text NOT NULL,                                -- expense | advance
  payee text,
  purpose text,
  amount numeric(14,2) NOT NULL,
  expense_account text NOT NULL DEFAULT '5100',
  doc_ref text,                                       -- external document/receipt no (document tracking)
  receipt_key text,                                   -- uploaded receipt image key
  status text NOT NULL DEFAULT 'PendingApproval',     -- PendingApproval | Approved | Rejected | Settled
  requested_by text,
  requested_at timestamptz DEFAULT now(),
  approved_by text,                                   -- checker — must differ from requested_by
  approved_at timestamptz,
  reject_reason text,
  settled_expense numeric(14,2),
  returned_cash numeric(14,2),
  settled_by text,
  settled_at timestamptz,
  gl_ref text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_req_no ON expense_requests (tenant_id, req_no);
CREATE INDEX IF NOT EXISTS idx_expense_req_status ON expense_requests (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_expense_req_fund ON expense_requests (fund_id);

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

-- Phase 14 — Accounting Tier 3 / Bank Reconciliation (การกระทบยอดธนาคาร).
-- Per-bank house-bank GL accounts (1010/1020 seeded in code), statement import, auto-match to GL cash.
DO $$ BEGIN CREATE TYPE bank_line_kind AS ENUM ('credit','debit'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS bank_accounts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  bank_name text NOT NULL,
  account_no text NOT NULL,
  gl_account_code text NOT NULL DEFAULT '1010',
  currency text DEFAULT 'THB',
  opening_balance numeric(18,4) NOT NULL DEFAULT 0,
  active text DEFAULT 'true',
  created_by text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_bank_acct UNIQUE (tenant_id, account_no)
);

CREATE TABLE IF NOT EXISTS bank_statements (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  statement_no text NOT NULL,
  bank_account_id bigint NOT NULL REFERENCES bank_accounts(id),
  statement_date date NOT NULL,
  opening_bal numeric(18,4) NOT NULL DEFAULT 0,
  closing_bal numeric(18,4) NOT NULL DEFAULT 0,
  line_count bigint NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_bank_stmt_no UNIQUE (tenant_id, statement_no)
);
CREATE INDEX IF NOT EXISTS idx_stmt_acct ON bank_statements(bank_account_id);

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  statement_id bigint NOT NULL REFERENCES bank_statements(id),
  bank_account_id bigint NOT NULL REFERENCES bank_accounts(id),
  line_date date NOT NULL,
  description text,
  amount numeric(18,4) NOT NULL,
  running_balance numeric(18,4),
  reconciled text NOT NULL DEFAULT 'false',
  matched_journal_line_id bigint,
  matched_payment_no text,
  adjustment_journal_no text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stmt_line_stmt ON bank_statement_lines(statement_id);
CREATE INDEX IF NOT EXISTS idx_stmt_line_acct ON bank_statement_lines(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_stmt_line_recon ON bank_statement_lines(reconciled);

-- Re-run the 0002 RLS loop so the three new tenant_id tables are isolation-scoped.
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

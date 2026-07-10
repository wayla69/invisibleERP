-- 0301_promptpay_store_recon — PromptPay store-level auto-reconciliation (POS-8, control POS-08).
-- Match PromptPay-tendered sales against imported bank-statement INFLOWS on the store's settlement
-- account (amount / date-window / payer-ref), REUSING the bank reconciliation auto-match engine
-- (modules/bank/match-engine.ts) — one matcher, scoped to the settlement account per store per day.
-- Two tenant-scoped tables back it:
--  (1) pos_settlement_accounts — maps a store (tenant) to the house-bank account its PromptPay QR
--      collections settle into, so recon knows which statement lines are candidate inflows. One per store.
--  (2) promptpay_till_exceptions — a PromptPay tender with no matching bank inflow is surfaced as a
--      till/cash EXCEPTION (mirrors the till-variance exception surface): status Open until a manager
--      clears it (Resolved), so unsettled/short-settled QR takings never go unnoticed.
CREATE TABLE IF NOT EXISTS pos_settlement_accounts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  bank_account_id bigint NOT NULL REFERENCES bank_accounts(id),
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT uq_pos_settlement_tenant UNIQUE (tenant_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pos_settlement_tenant ON pos_settlement_accounts (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS promptpay_till_exceptions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  recon_date date NOT NULL,
  payment_no text NOT NULL,
  till_session_id bigint,
  bank_account_id bigint REFERENCES bank_accounts(id),
  amount numeric(18,4) NOT NULL,
  gateway_ref text,
  status text NOT NULL DEFAULT 'Open',          -- Open | Resolved
  note text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_promptpay_exc UNIQUE (tenant_id, payment_no)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_promptpay_exc_tenant ON promptpay_till_exceptions (tenant_id, recon_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_promptpay_exc_status ON promptpay_till_exceptions (tenant_id, status);
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

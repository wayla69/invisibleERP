-- W3 — Cash banking (REC-05). Till cash 'drop's into the safe are batched into a bank deposit and posted
-- to GL (Dr bank account / Cr 1000 Cash), then reconciled to the bank statement. A 'drop' with deposit_id
-- NULL is cash still in the safe (a detective control surfaces that exposure).
ALTER TABLE cash_movements ADD COLUMN IF NOT EXISTS deposit_id bigint;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS bank_deposits (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  deposit_no text NOT NULL,
  bank_account_id bigint NOT NULL,
  amount numeric(18,4) NOT NULL,
  status text NOT NULL DEFAULT 'Deposited',
  deposit_date text,
  journal_no text,
  reconciled_by text,
  reconciled_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bank_deposits_status ON bank_deposits (tenant_id, status);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id table is isolation-scoped (idempotent — DROP POLICY IF EXISTS).
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

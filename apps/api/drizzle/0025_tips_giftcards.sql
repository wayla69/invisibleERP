-- POS Tier 2 #7 — Tips + Gift Cards / Store Credit (ทิป + บัตรของขวัญ).
-- New COA 2200 Customer Deposits + 2300 Tips Payable are seeded in code (seedChartOfAccounts, idempotent).

DO $$ BEGIN CREATE TYPE gift_card_status   AS ENUM ('Active','Redeemed','Void'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE gift_card_txn_type AS ENUM ('Issue','Redeem','Refund','Void'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS gift_cards (
  id bigserial PRIMARY KEY,
  card_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  initial_amount numeric(14,2) NOT NULL,
  balance numeric(14,2) NOT NULL,
  currency text DEFAULT 'THB',
  status gift_card_status DEFAULT 'Active',
  issued_sale_no text,
  note text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gift_card_txns (
  id bigserial PRIMARY KEY,
  txn_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  card_no text NOT NULL,
  type gift_card_txn_type NOT NULL,
  amount numeric(14,2) NOT NULL,
  balance_after numeric(14,2) NOT NULL,
  ref_doc text,
  journal_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);

-- tip columns on existing sale/payment tables
ALTER TABLE cust_pos_sales ADD COLUMN IF NOT EXISTS tip numeric(14,2) DEFAULT 0;
ALTER TABLE payments       ADD COLUMN IF NOT EXISTS tip numeric(18,4) DEFAULT 0;

-- Re-run the 0002 RLS loop so gift_cards + gift_card_txns (tenant_id) get tenant_isolation.
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

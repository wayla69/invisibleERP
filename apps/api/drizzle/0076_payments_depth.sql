-- 0076 — Payments depth (Phase 8): customer deposits (prepaid liability), house/charge accounts (AR with a
-- credit limit + foreign-currency settlement), and card-surcharge config. Each money movement posts its own
-- balanced JE (no change to the sale builders). New tenant_id tables → RLS loop re-run.

-- Customer deposits — cash received in advance (booking/tab). Liability 2210; recognised to revenue on apply.
CREATE TABLE IF NOT EXISTS customer_deposits (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  deposit_no text NOT NULL,
  member_id bigint,
  customer_name text,
  purpose text DEFAULT 'booking',        -- booking | tab | other
  amount numeric(14,2) NOT NULL,
  applied_amount numeric(14,2) NOT NULL DEFAULT 0,
  refunded_amount numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',   -- open | applied | refunded | closed
  sale_no text,
  journal_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_deposit ON customer_deposits (tenant_id, deposit_no);
--> statement-breakpoint

-- House / charge accounts — a POS customer's running AR balance with a credit limit.
CREATE TABLE IF NOT EXISTS house_accounts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  account_no text NOT NULL,
  member_id bigint,
  name text NOT NULL,
  credit_limit numeric(14,2) NOT NULL DEFAULT 0,
  balance numeric(14,2) NOT NULL DEFAULT 0,   -- amount the customer currently owes
  status text NOT NULL DEFAULT 'active',      -- active | hold | closed
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_house_account ON house_accounts (tenant_id, account_no);
--> statement-breakpoint

-- House-account ledger — charges (credit sale), payments (settlement) and adjustments, with running balance.
CREATE TABLE IF NOT EXISTS house_account_entries (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  account_id bigint NOT NULL,
  entry_no text NOT NULL,
  type text NOT NULL,                    -- charge | payment | adjustment
  sale_no text,
  amount numeric(14,2) NOT NULL,         -- signed in the type's natural direction (charge +, payment −)
  balance_after numeric(14,2) NOT NULL,
  currency text DEFAULT 'THB',
  fx_rate numeric(18,8) DEFAULT 1,
  fx_gain_loss numeric(14,2) DEFAULT 0,
  journal_no text,
  memo text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_house_entries_acct ON house_account_entries (tenant_id, account_id, id);
--> statement-breakpoint

-- Card-surcharge config — a percentage applied per payment method (e.g. credit cards).
CREATE TABLE IF NOT EXISTS payment_surcharges (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  method text NOT NULL,                  -- Card | Amex | ...
  pct numeric(6,3) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_surcharge ON payment_surcharges (tenant_id, method);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id tables are isolation-scoped.
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

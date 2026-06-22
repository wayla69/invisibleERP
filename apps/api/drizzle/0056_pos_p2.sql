-- 0053 — POS world-class P2: multi-terminal locking + auto-86, delivery-aggregator adapters,
-- loyalty tiers/expiry + house accounts + gift-card PIN, labor time-clock.

-- P2a — optimistic locking: a rev column bumped on every write; stale write → 409.
ALTER TABLE dining_tables ADD COLUMN IF NOT EXISTS rev integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS rev integer DEFAULT 0;
--> statement-breakpoint

-- P2b — per-tenant+platform aggregator config (Grab / LINE MAN / Foodpanda / Robinhood).
CREATE TABLE IF NOT EXISTS channel_adapters (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  platform text NOT NULL,             -- grab | lineman | foodpanda | robinhood
  store_ref text,                     -- partner's store id
  enabled boolean DEFAULT true,
  auto_accept boolean DEFAULT true,
  config jsonb,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

-- P2c — tiered loyalty (earn/redeem multipliers by lifetime points).
CREATE TABLE IF NOT EXISTS loyalty_tiers (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  tier text NOT NULL,
  min_lifetime numeric(14,2) DEFAULT '0',
  earn_mult numeric(6,3) DEFAULT '1',
  redeem_mult numeric(6,3) DEFAULT '1',
  sort integer DEFAULT 0,
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

-- P2c — gift-card PIN (activation/balance-check). Reload reuses the existing giftCardTxns ledger.
ALTER TABLE gift_cards ADD COLUMN IF NOT EXISTS pin text;
--> statement-breakpoint

-- P2c — labor time & attendance.
CREATE TABLE IF NOT EXISTS time_clock (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  employee_id bigint REFERENCES employees(id),
  emp_code text,
  clock_in timestamptz,
  clock_out timestamptz,
  break_minutes integer DEFAULT 0,
  hours numeric(8,2),
  status text DEFAULT 'Open',         -- Open | Closed
  note text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

-- Re-run RLS for the new tenant_id tables.
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

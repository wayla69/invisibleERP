-- 0051 — POS world-class P0: held orders, manager overrides, payment terminals/intents/settlements.
-- All tenant-scoped → RLS loop re-run at the end. Also harden offline idempotency with a unique index.

CREATE TABLE IF NOT EXISTS pos_held_orders (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  hold_no text NOT NULL,
  label text,
  customer_name text,
  cart jsonb NOT NULL,
  status text DEFAULT 'Held',          -- Held | Recalled | Discarded
  created_by text,
  created_at timestamptz DEFAULT now(),
  recalled_at timestamptz
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS pos_overrides (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  override_no text NOT NULL,
  sale_no text,
  action text NOT NULL,                -- void | discount | price_override | no_sale | return
  reason_code text,
  reason text,
  amount numeric(14,2),
  requested_by text,
  approved_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS payment_terminals (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  terminal_code text NOT NULL,
  name text,
  provider text DEFAULT 'mock',        -- mock | omise | 2c2p | gbprime
  status text DEFAULT 'active',        -- active | inactive
  last_seen_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS payment_intents (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  intent_no text NOT NULL,
  sale_no text,
  terminal_code text,
  provider text DEFAULT 'mock',
  provider_ref text,
  type text DEFAULT 'sale',            -- sale | preauth
  amount numeric(14,2) NOT NULL,
  captured_amount numeric(14,2) DEFAULT '0',
  currency text DEFAULT 'THB',
  status text DEFAULT 'RequiresPayment', -- RequiresPayment | Authorized | Captured | Voided | Refunded | Failed
  settlement_batch_no text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  captured_at timestamptz
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS settlement_batches (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  batch_no text NOT NULL,
  provider text,
  batch_date date,
  gross numeric(14,2) DEFAULT '0',
  fees numeric(14,2) DEFAULT '0',
  net numeric(14,2) DEFAULT '0',
  txn_count integer DEFAULT 0,
  status text DEFAULT 'Open',          -- Open | Settled | Reconciled
  reconciled_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint

-- P0a: DB-level idempotency for offline replay (dedup was app-only SELECT before).
CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_offline_client ON pos_offline_sync (tenant_id, client_uuid) WHERE client_uuid IS NOT NULL;
--> statement-breakpoint

-- Re-run the RLS loop so the new tenant_id tables are isolation-scoped.
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

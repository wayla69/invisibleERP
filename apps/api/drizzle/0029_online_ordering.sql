-- POS Tier 2 #10 — Online ordering + Delivery + Kiosk (สั่งออนไลน์ + เดลิเวอรี + คีออสก์).
-- New COA 4100 Delivery Income seeded in code (seedChartOfAccounts, idempotent).
DO $$ BEGIN CREATE TYPE order_channel      AS ENUM ('dine_in','web','kiosk','grab','lineman','in_store'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE fulfillment_type   AS ENUM ('dine_in','takeaway','delivery','pickup'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE fulfillment_status AS ENUM ('received','accepted','preparing','ready','out_for_delivery','completed','rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS channel            order_channel    NOT NULL DEFAULT 'dine_in';
ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS fulfillment_type   fulfillment_type NOT NULL DEFAULT 'dine_in';
ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS fulfillment_status fulfillment_status;
ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS delivery_fee       numeric(14,2)    NOT NULL DEFAULT 0;
ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS scheduled_at       timestamptz;
ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS public_token       text;
ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS ext_source         text;
ALTER TABLE dine_in_orders ADD COLUMN IF NOT EXISTS ext_order_id       text;
CREATE UNIQUE INDEX IF NOT EXISTS dine_in_orders_ext_uq ON dine_in_orders (tenant_id, ext_source, ext_order_id) WHERE ext_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS dine_in_orders_pubtok ON dine_in_orders (public_token) WHERE public_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_delivery_details (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  order_id bigint NOT NULL REFERENCES dine_in_orders(id),
  contact_name text, contact_phone text, address_line text, address_note text,
  lat numeric(10,6), lng numeric(10,6),
  courier_name text, courier_phone text,
  dispatched_at timestamptz, delivered_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS order_delivery_details_order_uq ON order_delivery_details (order_id);

CREATE TABLE IF NOT EXISTS channel_webhook_events (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  source text NOT NULL,
  ext_event_id text NOT NULL,
  ext_order_id text,
  order_no text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'processed',
  received_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_webhook_events_uq ON channel_webhook_events (source, ext_event_id);

-- Re-run the 0002 RLS loop so the new tenant_id tables get tenant_isolation.
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

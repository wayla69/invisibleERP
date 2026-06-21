-- Phase 11: Restaurant / F&B POS — kitchen stations + KDS, floor-plan zones/tables, table sessions
-- (public QR diner sessions), dine-in orders + items. RLS auto-applies via the DO-block re-run at the tail.
DO $$ BEGIN CREATE TYPE dine_in_order_status AS ENUM ('open','sent_to_kitchen','partially_ready','served','bill_requested','paid','closed','cancelled'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE kds_item_status AS ENUM ('new','queued','preparing','ready','served','voided'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE table_status AS ENUM ('available','reserved','occupied','bill_requested','paying','cleaning','out_of_service'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE table_session_status AS ENUM ('open','bill_requested','paying','closed','abandoned'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS kitchen_stations (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL, name text NOT NULL, sort int DEFAULT 0,
  default_prep_minutes int DEFAULT 10, active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS floor_zones (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  name text NOT NULL, sort_order int DEFAULT 0, active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dining_tables (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  zone_id bigint REFERENCES floor_zones(id),
  table_no text NOT NULL, seats int DEFAULT 4, shape text DEFAULT 'rect',
  pos_x numeric(8,2) DEFAULT 0, pos_y numeric(8,2) DEFAULT 0,
  width numeric(8,2) DEFAULT 80, height numeric(8,2) DEFAULT 80, rotation int DEFAULT 0,
  status table_status DEFAULT 'available', qr_token text, active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS table_sessions (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  table_id bigint NOT NULL REFERENCES dining_tables(id),
  session_no text NOT NULL UNIQUE, public_token text NOT NULL,
  status table_session_status DEFAULT 'open', party_size int,
  opened_at timestamptz DEFAULT now(), closed_at timestamptz,
  opened_by text, sale_no text, notes text
);

CREATE TABLE IF NOT EXISTS dine_in_orders (
  id bigserial PRIMARY KEY,
  order_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  table_id bigint REFERENCES dining_tables(id),
  session_id bigint REFERENCES table_sessions(id),
  status dine_in_order_status NOT NULL DEFAULT 'open',
  guest_count int DEFAULT 1, server text,
  subtotal numeric(14,2) DEFAULT 0, vat numeric(14,2) DEFAULT 0, total numeric(14,2) DEFAULT 0,
  sale_no text, notes text,
  opened_at timestamptz DEFAULT now(), fired_at timestamptz, bill_requested_at timestamptz,
  paid_at timestamptz, closed_at timestamptz, created_by text
);

CREATE TABLE IF NOT EXISTS dine_in_order_items (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  order_id bigint REFERENCES dine_in_orders(id),
  station_id bigint REFERENCES kitchen_stations(id),
  item_id text, name text NOT NULL, qty numeric NOT NULL DEFAULT 1,
  unit_price numeric(14,2) NOT NULL, amount numeric(14,2) NOT NULL,
  modifiers jsonb, notes text,
  kds_status kds_item_status NOT NULL DEFAULT 'new', est_prep_minutes int,
  fired_at timestamptz, started_at timestamptz, ready_at timestamptz, served_at timestamptz,
  voided_at timestamptz, void_reason text, created_by text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dining_tables_tenant_no_uq ON dining_tables (tenant_id, table_no) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS dining_tables_qr_token_uq ON dining_tables (qr_token);
CREATE UNIQUE INDEX IF NOT EXISTS table_sessions_public_token_uq ON table_sessions (public_token);
CREATE UNIQUE INDEX IF NOT EXISTS table_sessions_one_open_per_table ON table_sessions (table_id) WHERE status IN ('open','bill_requested','paying');
CREATE INDEX IF NOT EXISTS dine_in_items_kds ON dine_in_order_items (kds_status, fired_at);
CREATE INDEX IF NOT EXISTS dine_in_items_order ON dine_in_order_items (order_id);
CREATE INDEX IF NOT EXISTS dine_in_orders_table ON dine_in_orders (table_id, status);

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

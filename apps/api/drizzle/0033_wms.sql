-- Phase 17B — WMS (bins/pick/pack/ship/wave) + replenishment + RMA. No new GL (RMA reuses returns).
-- RLS via the 0002 DO-block re-run at tail (every table carries tenant_id).
CREATE TABLE IF NOT EXISTS bins (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  bin_code text NOT NULL,
  location_id text REFERENCES locations(location_id),
  aisle text, rack text, level text,
  bin_type text NOT NULL DEFAULT 'storage',
  capacity numeric,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT bins_tenant_code_uq UNIQUE (tenant_id, bin_code)
);
CREATE TABLE IF NOT EXISTS bin_stock (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  bin_id bigint NOT NULL REFERENCES bins(id),
  item_id text NOT NULL,
  lot_no text DEFAULT '',
  qty numeric NOT NULL DEFAULT 0,
  uom text, expiry_date date,
  last_updated timestamptz DEFAULT now(),
  CONSTRAINT bin_stock_slot_uq UNIQUE (tenant_id, bin_id, item_id, lot_no)
);
CREATE INDEX IF NOT EXISTS idx_binstock_item ON bin_stock (tenant_id, item_id);
CREATE TABLE IF NOT EXISTS pick_waves (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  wave_no text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'Open',
  order_count integer NOT NULL DEFAULT 0,
  created_by text, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS pick_lists (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  pick_no text NOT NULL UNIQUE,
  wave_id bigint REFERENCES pick_waves(id),
  source_type text NOT NULL, source_ref text NOT NULL,
  status text NOT NULL DEFAULT 'Open',
  created_by text, created_at timestamptz DEFAULT now(),
  CONSTRAINT pick_source_uq UNIQUE (tenant_id, source_type, source_ref)
);
CREATE TABLE IF NOT EXISTS pick_list_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  pick_id bigint NOT NULL REFERENCES pick_lists(id),
  item_id text NOT NULL, item_description text,
  requested_qty numeric NOT NULL, picked_qty numeric NOT NULL DEFAULT 0,
  bin_id bigint REFERENCES bins(id), lot_no text, uom text,
  status text NOT NULL DEFAULT 'Open'
);
CREATE TABLE IF NOT EXISTS shipments (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  shipment_no text NOT NULL UNIQUE,
  pick_id bigint REFERENCES pick_lists(id),
  wave_id bigint REFERENCES pick_waves(id),
  source_type text, source_ref text,
  carrier text, tracking_no text,
  status text NOT NULL DEFAULT 'Packed',
  packed_by text, packed_at timestamptz,
  shipped_by text, shipped_at timestamptz
);
CREATE TABLE IF NOT EXISTS replenishment_suggestions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  suggestion_no text NOT NULL UNIQUE,
  item_id text NOT NULL,
  on_hand numeric NOT NULL, reorder_point numeric NOT NULL, suggested_qty numeric NOT NULL,
  urgency text, status text NOT NULL DEFAULT 'Suggested', pr_no text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rpl_item ON replenishment_suggestions (tenant_id, item_id, status);
CREATE TABLE IF NOT EXISTS rmas (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  rma_no text NOT NULL UNIQUE,
  sale_no text, customer_ref text,
  status text NOT NULL DEFAULT 'Requested',
  reason text, return_no text,
  created_by text, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rma_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  rma_id bigint NOT NULL REFERENCES rmas(id),
  sale_item_id bigint, item_id text NOT NULL, qty numeric NOT NULL, lot_no text, uom text,
  disposition text NOT NULL DEFAULT 'restock', restock_bin_id bigint REFERENCES bins(id)
);

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

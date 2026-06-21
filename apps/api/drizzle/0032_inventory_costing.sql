-- Phase 17A — Inventory costing (FIFO/AVG/STD) + valuation + ATP. Opt-in per (tenant,item) via
-- item_costing. Configured items: GR capitalizes Dr 1200 / Cr 2000 (STD adds PPV 5500); sale posts
-- costed COGS Dr 5000 / Cr 1200. Recipe COGS (5300, restaurant) untouched. RLS via the 0002 tail block.
CREATE TABLE IF NOT EXISTS item_costing (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  item_id text,
  method text NOT NULL DEFAULT 'AVG',
  standard_cost numeric(14,4),
  avg_cost numeric(14,4) DEFAULT 0,
  on_hand numeric(18,4) DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT item_costing_uq UNIQUE (tenant_id, item_id)
);
CREATE TABLE IF NOT EXISTS cost_layers (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  item_id text NOT NULL,
  gr_no text, receipt_date date NOT NULL,
  orig_qty numeric(18,4) NOT NULL, remaining_qty numeric(18,4) NOT NULL,
  unit_cost numeric(14,4) NOT NULL, created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_layer_item ON cost_layers (tenant_id, item_id, receipt_date, id);
CREATE TABLE IF NOT EXISTS cost_movements (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  item_id text NOT NULL, move_date date NOT NULL,
  kind text NOT NULL, ref_doc text NOT NULL,
  qty numeric(18,4) NOT NULL, unit_cost numeric(14,4) NOT NULL, ext_cost numeric(18,4) NOT NULL,
  method text NOT NULL, created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_costmv_ref ON cost_movements (tenant_id, ref_doc);
CREATE INDEX IF NOT EXISTS idx_costmv_item ON cost_movements (tenant_id, item_id, move_date);
CREATE TABLE IF NOT EXISTS stock_allocations (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  item_id text NOT NULL, ref_doc text NOT NULL,
  qty numeric(18,4) NOT NULL, need_by date,
  status text NOT NULL DEFAULT 'Open', created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alloc_item ON stock_allocations (tenant_id, item_id, status);

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

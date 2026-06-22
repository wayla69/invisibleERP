-- Phase 18: Manufacturing — work orders (ใบสั่งผลิต) + components. Tenant-scoped (RLS).
CREATE TABLE IF NOT EXISTS work_orders (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT REFERENCES tenants(id),
  wo_no           TEXT NOT NULL,
  bom_id          BIGINT,
  bom_code        TEXT,
  product_item_id TEXT,
  product_name    TEXT,
  uom             TEXT,
  qty_planned     NUMERIC(14,3) NOT NULL DEFAULT 0,
  qty_produced    NUMERIC(14,3) DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'Open',
  material_cost   NUMERIC(16,2) DEFAULT 0,
  labor_cost      NUMERIC(16,2) DEFAULT 0,
  overhead_cost   NUMERIC(16,2) DEFAULT 0,
  total_cost      NUMERIC(16,2) DEFAULT 0,
  unit_cost       NUMERIC(16,4) DEFAULT 0,
  entry_no_issue    TEXT,
  entry_no_complete TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wo_tenant ON work_orders(tenant_id);

CREATE TABLE IF NOT EXISTS work_order_components (
  id              BIGSERIAL PRIMARY KEY,
  wo_id           BIGINT NOT NULL REFERENCES work_orders(id),
  tenant_id       BIGINT REFERENCES tenants(id),
  item_id         TEXT,
  item_description TEXT,
  uom             TEXT,
  qty_required    NUMERIC(14,3) DEFAULT 0,
  unit_cost       NUMERIC(14,4) DEFAULT 0,
  line_cost       NUMERIC(16,2) DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_woc_wo ON work_order_components(wo_id);

-- dynamic tenant_isolation RLS for the new tenant-scoped tables (mirror drizzle/0002_rls.sql)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY['work_orders','work_order_components']) AS table_name LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint)'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint)',
      r.table_name);
  END LOOP;
END $$;

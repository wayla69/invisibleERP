-- Phase 18 depth: routings + shop-floor operations + quality inspections. Tenant-scoped (RLS).
-- NOTE: 0052 in this worktree (after 0051_projects); reconcile journal idx vs the parallel pos_p0 at merge.
CREATE TABLE IF NOT EXISTS routings (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT REFERENCES tenants(id),
  routing_code    TEXT NOT NULL,
  product_item_id TEXT,
  name            TEXT,
  active          BOOLEAN DEFAULT true,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_routing_tenant ON routings(tenant_id);

CREATE TABLE IF NOT EXISTS routing_operations (
  id                BIGSERIAL PRIMARY KEY,
  routing_id        BIGINT NOT NULL REFERENCES routings(id),
  tenant_id         BIGINT REFERENCES tenants(id),
  op_no             NUMERIC NOT NULL,
  work_center       TEXT,
  description       TEXT,
  setup_min         NUMERIC(12,2) DEFAULT 0,
  run_min_per_unit  NUMERIC(12,4) DEFAULT 0,
  labor_rate        NUMERIC(12,2) DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rop_routing ON routing_operations(routing_id);

CREATE TABLE IF NOT EXISTS work_order_operations (
  id            BIGSERIAL PRIMARY KEY,
  wo_id         BIGINT NOT NULL,
  tenant_id     BIGINT REFERENCES tenants(id),
  op_no         NUMERIC NOT NULL,
  work_center   TEXT,
  description   TEXT,
  planned_qty   NUMERIC(14,3) DEFAULT 0,
  completed_qty NUMERIC(14,3) DEFAULT 0,
  scrap_qty     NUMERIC(14,3) DEFAULT 0,
  labor_cost    NUMERIC(16,2) DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'Pending',
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_woo_wo ON work_order_operations(wo_id);

CREATE TABLE IF NOT EXISTS quality_inspections (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT REFERENCES tenants(id),
  insp_no         TEXT NOT NULL,
  ref_type        TEXT NOT NULL,
  ref_doc         TEXT,
  item_id         TEXT,
  item_description TEXT,
  qty_inspected   NUMERIC(14,3) DEFAULT 0,
  qty_passed      NUMERIC(14,3) DEFAULT 0,
  qty_failed      NUMERIC(14,3) DEFAULT 0,
  disposition     TEXT NOT NULL DEFAULT 'Accept',
  scrap_value     NUMERIC(16,2) DEFAULT 0,
  entry_no        TEXT,
  notes           TEXT,
  inspected_by    TEXT,
  inspected_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qi_tenant ON quality_inspections(tenant_id);

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT unnest(ARRAY['routings','routing_operations','work_order_operations','quality_inspections']) AS table_name LOOP
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

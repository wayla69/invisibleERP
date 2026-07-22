-- docs/57 Track B (B1) — multi-echelon supply-network master data.
--
-- Two tenant tables modelling the supply topology as governed master data: supply_nodes
-- (supplier / central-kitchen / DC / branch, with an echelon index) and supply_lanes (the directed
-- edges, each with its own lead-time distribution + ordering constraints). B1 is definition only; the
-- two-echelon optimizer (B2) consumes them later.
--
-- Tenancy: both carry tenant_id, so the trailing DO block's CANONICAL 0232-form org loop enables
-- tenant_isolation; the leading (tenant_id, …) indexes satisfy the cutover:tenant-idx gate. No other
-- module writes these tables (no cross-writer NULL-tenant fan-out to sweep).
CREATE TABLE IF NOT EXISTS supply_nodes (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  node_code text NOT NULL,                          -- tenant-unique business key
  name text NOT NULL,
  name_th text,
  kind text NOT NULL,                               -- 'supplier' | 'central_kitchen' | 'dc' | 'branch'
  echelon integer NOT NULL,                         -- 0 supplier · 1 DC/kitchen · 2 branch
  branch_id bigint,                                 -- → branches(id) when kind='branch' (intra-tenant)
  service_time_out_days numeric(8,2) NOT NULL DEFAULT 0,
  holding_cost_per_day numeric(18,6) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_supply_nodes_code ON supply_nodes (tenant_id, node_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_supply_nodes_tenant ON supply_nodes (tenant_id, node_code);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS supply_lanes (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  from_node_id bigint NOT NULL,
  to_node_id bigint NOT NULL,
  lead_time_mean_days numeric(8,2) NOT NULL DEFAULT 0,
  lead_time_std_days numeric(8,2) NOT NULL DEFAULT 0,
  unit_cost numeric(18,6) NOT NULL DEFAULT 0,
  moq numeric(18,4) NOT NULL DEFAULT 0,
  pack_size numeric(18,4) NOT NULL DEFAULT 1,
  fixed_order_cost numeric(18,6) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_supply_lanes_edge ON supply_lanes (tenant_id, from_node_id, to_node_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_supply_lanes_tenant ON supply_lanes (tenant_id, from_node_id, to_node_id);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))',
      r.table_name);
  END LOOP;
END $$;

-- docs/58 Track C (C1) — declared aggregation structures for hierarchical forecast reconciliation.
--
-- One planning-owned mapping table, self-referencing parent, so a tenant can declare
-- branch → region → company (region rows ref_kind='group') or an arbitrary item roll-up. Absent ⇒
-- the API synthesizes the forest from branches + item_categories (Track C stays off until declared).
--
-- Tenancy: carries tenant_id, so the trailing DO block's CANONICAL 0232-form org loop enables
-- tenant_isolation; the leading (tenant_id, axis) index satisfies the cutover:tenant-idx gate. No
-- other module writes this table (no cross-writer NULL-tenant fan-out to sweep).
CREATE TABLE IF NOT EXISTS scm_forecast_hierarchy (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  axis text NOT NULL,                          -- 'branch' | 'item'
  node_code text NOT NULL,                      -- natural key per (tenant, axis)
  name text,
  name_th text,
  parent_id bigint,                             -- → scm_forecast_hierarchy(id); null = a root (total)
  level integer NOT NULL DEFAULT 0,             -- 0 = leaf, increasing toward the root (denormalized)
  ref_kind text,                                -- 'branch' | 'item_category' | 'group'
  ref_id text,                                  -- branches.id / item_categories.code for a leaf/mid node
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_forecast_hierarchy_node ON scm_forecast_hierarchy (tenant_id, axis, node_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_forecast_hierarchy_tenant ON scm_forecast_hierarchy (tenant_id, axis);
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

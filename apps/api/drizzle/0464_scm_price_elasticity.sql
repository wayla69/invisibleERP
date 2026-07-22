-- docs/56 Track A (A2) — persisted own-price elasticity per (tenant, item[, branch]).
--
-- The forecast engine estimates ε (a log-log demand↔price slope) with an identifiability floor and
-- returns it in the forecast attribution; a planning run upserts the latest CREDIBLE value here so the
-- advisory scenario tool can apply a price response without re-fitting. Only identified estimates are
-- stored (a NULL/unidentified ε is never written), so the scenario tool cleanly falls back to a unit
-- response when nothing is on file.
--
-- Tenancy: carries tenant_id, so the trailing DO block's CANONICAL 0232-form org loop enables
-- tenant_isolation; the leading (tenant_id, item_id) index satisfies the cutover:tenant-idx gate. Only
-- the scm-planning run writes it (no cross-writer NULL-tenant fan-out to sweep).
CREATE TABLE IF NOT EXISTS scm_price_elasticity (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  item_id text NOT NULL,
  branch_id bigint,                              -- null = tenant-wide (series aggregated over branches)
  elasticity numeric(10,4) NOT NULL,             -- ε (log-log slope), typically < 0
  r2 numeric(6,4),
  n_obs integer NOT NULL DEFAULT 0,
  estimated_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
-- Unique per (tenant, item, branch) — coalesce so the tenant-wide (NULL branch) row is unique too.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_price_elasticity_key ON scm_price_elasticity (tenant_id, item_id, coalesce(branch_id, 0));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_price_elasticity_tenant ON scm_price_elasticity (tenant_id, item_id);
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

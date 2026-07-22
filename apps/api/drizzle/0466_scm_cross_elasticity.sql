-- docs/56 Track A (A3) — category-scoped cross-price elasticity (cannibalization / halo).
--
-- γ_{a,b} = ∂log(demand_a)/∂log(price_b), estimated API-side only for sibling pairs sharing an
-- item_categories category (never the full cross-product), with the same identifiability floor as the
-- own-price elasticity (A2). A credible γ means a promotion on item_b moves its sibling item_a's
-- demand: γ>0 substitutes (cannibalization), γ<0 complements (halo). Only identified estimates are
-- stored, so the scenario tool cleanly falls back to no cross-effect when nothing is on file.
--
-- Tenancy: carries tenant_id, so the trailing DO block's CANONICAL 0232-form org loop enables
-- tenant_isolation; the leading (tenant_id, item_a) index satisfies the cutover:tenant-idx gate. Only
-- the scm-planning run writes it (no cross-writer NULL-tenant fan-out to sweep).
CREATE TABLE IF NOT EXISTS scm_cross_elasticity (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  item_a text NOT NULL,
  item_b text NOT NULL,
  category text,
  gamma numeric(10,4) NOT NULL,
  r2 numeric(6,4),
  n_obs integer NOT NULL DEFAULT 0,
  estimated_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_cross_elasticity_pair ON scm_cross_elasticity (tenant_id, item_a, item_b);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_cross_elasticity_tenant ON scm_cross_elasticity (tenant_id, item_a);
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

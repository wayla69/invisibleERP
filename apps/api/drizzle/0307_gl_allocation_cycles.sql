-- 0307_gl_allocation_cycles — GL allocation engine (FIN-7b, GL-23). Periodic cost-allocation cycles that
-- distribute a source POOL (an amount out of a source account / cost-center) to a set of targets by fixed
-- ratio, a measured driver, or a statistical key (headcount / sqm). Each due run posts ONE balanced JE
-- (Cr the source pool; Dr each target its proportional share, last target absorbing the rounding remainder)
-- as a DRAFT through the maker-checker flow (GL-05), riding the recurring rail (GL-08 pattern). Two new
-- tenant-scoped tables: allocation_cycles (the definition + cadence) and allocation_targets (the child
-- weights). Idempotent per period via the (tenant,source,source_ref,ledger) JE key + next_run_date advance.
CREATE TABLE IF NOT EXISTS allocation_cycles (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  cycle_no text NOT NULL UNIQUE,
  name text NOT NULL,
  method text NOT NULL DEFAULT 'ratio',
  frequency text NOT NULL,
  pool_amount numeric(18,4) NOT NULL,
  source_account text NOT NULL,
  source_cost_center text,
  ledger_code text,
  currency text DEFAULT 'THB',
  memo text,
  active text DEFAULT 'true',
  next_run_date date,
  last_run_date date,
  last_entry_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_alloc_cycles_tenant_due ON allocation_cycles (tenant_id, next_run_date);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS allocation_targets (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  cycle_id bigint NOT NULL REFERENCES allocation_cycles(id),
  target_account text,
  cost_center text,
  basis numeric(18,4) NOT NULL DEFAULT 0,
  memo text,
  sort_order bigint DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_alloc_targets_tenant_cycle ON allocation_targets (tenant_id, cycle_id);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the two new
-- tables get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

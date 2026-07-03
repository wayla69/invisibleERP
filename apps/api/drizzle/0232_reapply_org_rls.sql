-- 0232 — Re-apply the org-scoped RLS clause to EVERY tenant_id table (ITGC-AC-18 fix).
--
-- ROOT CAUSE: 0196_hybrid_org_tenancy added the org clause to `tenant_isolation` on every tenant_id table
-- via a DO-loop. 0218_tenant_indexes_backfill (the 2026-07-03 prod hotfix for the 0145/0146 skip) later
-- re-ran the RLS loop to (re)enable RLS on backfilled tables — but its loop recreated `tenant_isolation`
-- with the PLAIN body (bypass OR tenant_id = app.tenant_id), silently DROPPING 0196's org clause on every
-- DATA table (background_jobs, orders, …). Net effect in TENANCY_MODE=multi-company: an org-scoped Admin
-- (app.org_id set) saw ONLY its own tenant's rows, never a sibling tenant's in the same org — over-isolated,
-- fail-CLOSED (no leak, but cross-account org SHARING did not work). The `tenants` self-policy was NOT
-- affected (0196 set it via direct DDL and `tenants` has no tenant_id column, so neither loop touches it) —
-- which is why org isolation at the tenants level kept working while data-table org sharing silently broke.
--
-- FIX: re-run the loop with the org clause so it WINS over 0218 (this migration applies last). The org
-- subquery depends only on the app.org_id GUC (an InitPlan evaluated once per query), so the per-row cost is
-- unchanged and the plain single-company path (app.bypass_rls='on' / app.tenant_id) is byte-for-byte the
-- same as before. Body is identical to 0196's intended policy. Idempotent (DROP POLICY IF EXISTS).
--
-- Runs on BOTH backends: PGlite executes plpgsql DO-blocks + information_schema + EXECUTE format() just like
-- real Postgres, so no separate generated statement list is needed. This is the CANONICAL policy form — any
-- new tenant_id table's hand-appended RLS loop should use THIS body (with the org clause), not the plain one,
-- or it will silently lack org sharing (the pg-core `org1` check guards background_jobs against regression).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
  LOOP
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

-- 0303 — Tenant isolation for stocktakes + stock_movements (ITGC-AC-18 / R11 fix).
--
-- FINDING: neither table carried a `tenant_id`, so the generic RLS loop never covered them and every
-- read/write was GLOBAL:
--   * `GET /api/stocktake` (perm wh_count/mobile) listed EVERY tenant's count sheets — item ids, system
--     vs physical quantities, variances.
--   * `GET /api/stocktake/:stNo` and `POST /api/stocktake/:stNo/post` resolve a document by its number
--     alone, so one tenant could read — and POST the variance movements of — ANOTHER tenant's count.
--   * `GET /api/inventory/movements` listed every tenant's movement history.
--
-- Fix: add the column, index it tenant-leading (the cutover/tenant-idx gate requires this), and let the
-- CANONICAL org-scoped RLS policy (0232 form) cover both tables. The services additionally thread an
-- explicit tenant_id (defence in depth — mantra: never rely on RLS alone for the write path).
--
-- Legacy rows keep tenant_id NULL: under the policy they are visible only to a bypass (HQ/god) session,
-- never to another tenant. There is no reliable way to attribute them retroactively (no tenant hint on
-- the row, and doc numbers are per-day sequences shared across tenants), so they are deliberately left
-- unattributed rather than guessed into someone's books.
ALTER TABLE stocktakes ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tenants(id);
--> statement-breakpoint
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES tenants(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stocktakes_tenant ON stocktakes (tenant_id, st_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stock_movements_tenant ON stock_movements (tenant_id, move_date);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the two
-- newly tenant-scoped tables get RLS with the org-sharing clause. Idempotent; PGlite + Postgres alike.
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

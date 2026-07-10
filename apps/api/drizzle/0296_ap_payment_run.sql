-- 0296_ap_payment_run — AP payment run (EXP-13, docs/41 FIN-2). Combined vendor payment: a single
-- disbursement run now settles MANY bills at once. Modelled as a `run_no` grouping over the existing
-- per-bill ap_payments rows (mirrors AR cash application's batch_no in 0295 — no separate header table):
-- the maker selects several due bills into ONE run (each line still passes the 3-way match gate, over-pay
-- guard and optional WHT exactly as a single payment does), and the checker approves/rejects the whole run
-- (a DIFFERENT user — SoD). Existing single-invoice payments keep run_no NULL (back-compat). Tenant-scoped
-- (RLS + a tenant-leading run_no index).
ALTER TABLE ap_payments ADD COLUMN IF NOT EXISTS run_no text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_payments_run ON ap_payments (tenant_id, run_no);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent;
-- runs on PGlite + Postgres alike. (ap_payments already has tenant_id — this keeps its policy canonical.)
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

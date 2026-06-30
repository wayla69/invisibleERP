-- 0206_project_close_review — PROJ-03 period-end project-close WIP/clearing review + sign-off (maker-checker).
-- A preparer snapshots unbilled-WIP (GL 1260) + the applied-costs clearing balance (GL 2390) + open-project
-- count and signs (Prepared); an independent approver (SoD) signs off (Approved). One row per (tenant, period).
-- Tenant-scoped → re-run the RLS loop so the new table gets tenant_isolation. Mirrors 0205_ic_recon_periods.
CREATE TABLE IF NOT EXISTS project_close_reviews (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  period text NOT NULL,                       -- YYYY-MM
  status text NOT NULL DEFAULT 'Prepared',    -- Prepared | Approved | Rejected
  wip_total numeric(16,2) NOT NULL DEFAULT 0,         -- GL 1260 net (debit - credit, Posted)
  clearing_balance numeric(16,2) NOT NULL DEFAULT 0,  -- GL 2390 net (credit - debit, Posted)
  open_projects integer NOT NULL DEFAULT 0,
  prepared_by text,
  prepared_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  rejection_reason text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS project_close_review_tenant_period_uq ON project_close_reviews (tenant_id, period);
--> statement-breakpoint
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)', r.table_name);
  END LOOP;
END $$;

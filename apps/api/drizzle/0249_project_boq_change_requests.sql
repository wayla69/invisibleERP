-- 0249_project_boq_change_requests — Project material scope-change authorisation (docs/32, PROJ-15). A
-- requester (pr_raise) can REQUEST that a material item NOT on a project's approved BoQ be added to the
-- budget, but cannot add it themselves: the request parks 'pending' and an independent authoriser
-- (planner/exec, ≠ requester → maker-checker) must approve it. On approval a new material line is appended to
-- the project's approved BoQ (the budget grows by qty × rate) and the item becomes shoppable; on reject
-- nothing changes. This closes the shop-for-a-project loop — a requester can only request budget, never
-- expand it. Tenant-scoped (RLS + tenant-leading indexes).
CREATE TABLE IF NOT EXISTS project_boq_change_requests (
  id bigserial PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES projects(id),
  boq_id bigint REFERENCES project_boq(id),          -- the approved BoQ the line is appended to on approval
  tenant_id bigint REFERENCES tenants(id),
  req_no text NOT NULL,
  item_no text,                                       -- → items.item_id (may be a new/free-text code)
  description text,
  uom text,
  qty numeric(18,4) NOT NULL DEFAULT 0,
  rate numeric(16,2) NOT NULL DEFAULT 0,
  amount numeric(16,2) NOT NULL DEFAULT 0,            -- = qty × rate (the budget it adds)
  status text NOT NULL DEFAULT 'pending',             -- pending | approved | rejected
  new_boq_line_id bigint REFERENCES project_boq_lines(id),  -- the line created on approval
  requested_by text,
  approved_by text,                                   -- checker — must differ from requested_by (SoD)
  approved_at timestamptz,
  rejection_reason text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bqr_project ON project_boq_change_requests (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bqr_tenant ON project_boq_change_requests (tenant_id, status);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new table
-- gets RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

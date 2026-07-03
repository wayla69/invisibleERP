-- 0239_project_material_requisitions — Project material control M2 (docs/32, PROJ-13). The Project Material
-- Requisition (PMR): site staff draw material against a project's BoQ. Within budget → a project-tagged PR is
-- raised; over budget → parked pending an authoriser (maker-checker + one-tap LINE approval) → on approval an
-- authorised over-budget project-tagged PO is auto-drafted. Tenant-scoped (RLS + tenant-leading indexes).
CREATE TABLE IF NOT EXISTS project_material_requisitions (
  id bigserial PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES projects(id),
  tenant_id bigint REFERENCES tenants(id),
  pmr_no text NOT NULL,
  status text NOT NULL DEFAULT 'pending',           -- routed | pending | approved | rejected
  route text,                                        -- pr | po
  over_budget boolean NOT NULL DEFAULT false,
  est_cost numeric(16,2) NOT NULL DEFAULT 0,
  over_amount numeric(16,2) NOT NULL DEFAULT 0,
  linked_doc_no text,
  requested_by text,
  approved_by text,
  approved_at timestamptz,
  rejection_reason text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pmr_project ON project_material_requisitions (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pmr_tenant ON project_material_requisitions (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pmr_lines (
  id bigserial PRIMARY KEY,
  pmr_id bigint NOT NULL REFERENCES project_material_requisitions(id),
  boq_line_id bigint NOT NULL REFERENCES project_boq_lines(id),
  tenant_id bigint REFERENCES tenants(id),
  item_no text,
  qty numeric(18,4) NOT NULL DEFAULT 0,
  unit_cost numeric(16,2) NOT NULL DEFAULT 0,
  est_cost numeric(16,2) NOT NULL DEFAULT 0,
  remaining numeric(16,2) NOT NULL DEFAULT 0,
  over_budget boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pmr_line_pmr ON pmr_lines (pmr_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pmr_line_tenant ON pmr_lines (tenant_id, pmr_id);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new tables
-- get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

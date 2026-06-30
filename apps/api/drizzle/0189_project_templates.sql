-- 0189_project_templates — reusable WBS/milestone scaffolds (PPM next-level B2, docs/20). A template holds a
-- standard set of task + milestone items (with relative date offsets, planned effort/cost, WBS nesting and
-- dependencies by seq); applying it to a project spins up a complete WBS + milestone set in one step.
-- Operational (non-financial) — no new control. Tenant-scoped → re-run the RLS loop (idempotent).
CREATE TABLE IF NOT EXISTS project_templates (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',               -- active | archived
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ptemplate_tenant ON project_templates (tenant_id);
--> statement-breakpoint
-- A single item row scaffolds either a task or a milestone (item_type). seq is the in-template ordinal that
-- parent_seq / depends_on_seq reference (resolved to real task ids when applied). Dates are RELATIVE offsets
-- (days) from the project start, so one template fits any start date.
CREATE TABLE IF NOT EXISTS project_template_items (
  id bigserial PRIMARY KEY,
  template_id bigint NOT NULL REFERENCES project_templates(id),
  tenant_id bigint REFERENCES tenants(id),
  item_type text NOT NULL DEFAULT 'task',              -- task | milestone
  seq integer NOT NULL DEFAULT 0,
  name text NOT NULL,
  parent_seq integer,                                  -- WBS nesting (references another item's seq)
  wbs_code text,
  planned_hours numeric(14,2) DEFAULT 0,
  planned_cost numeric(16,2) DEFAULT 0,
  offset_start_days integer DEFAULT 0,                 -- days after project start
  offset_end_days integer DEFAULT 0,
  depends_on_seq text,                                 -- CSV of predecessor seqs (finish-to-start)
  billing_percent numeric(5,2),                        -- milestone → % of contract to bill on reach
  owner text,                                          -- milestone owner
  assignee text,                                       -- task assignee (role/name)
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ptemplate_item_template ON project_template_items (template_id);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id tables are isolation-scoped (idempotent — DROP POLICY IF EXISTS).
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

-- 0184_project_wbs — WBS tasks + milestones for projects (PPM roadmap P1, docs/19).
-- project_tasks: a work-breakdown hierarchy (parent_id) per project with planned effort/cost + % complete;
-- the project's overall % complete rolls up from its tasks (planned-hours-weighted). Operational/non-financial.
-- project_milestones: due-date/owner/status gates; an optional billing_percent ties milestone completion to a
-- Fixed-price progress bill via the existing authorized PRJ-BILL path (PROJ-02). Both tables are tenant-scoped →
-- re-run the RLS loop so they are isolation-scoped (idempotent: DROP POLICY IF EXISTS).
CREATE TABLE IF NOT EXISTS project_tasks (
  id bigserial PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES projects(id),
  tenant_id bigint REFERENCES tenants(id),
  parent_id bigint,                                     -- WBS hierarchy (nullable → top-level)
  wbs_code text,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'open',                  -- open | in_progress | done | cancelled
  planned_start date,
  planned_end date,
  planned_hours numeric(14,2) DEFAULT 0,
  planned_cost numeric(16,2) DEFAULT 0,
  pct_complete numeric(5,2) DEFAULT 0,                  -- 0..100
  assignee text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ptask_project ON project_tasks (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ptask_parent ON project_tasks (parent_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_milestones (
  id bigserial PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES projects(id),
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  due_date date,
  owner text,
  status text NOT NULL DEFAULT 'pending',               -- pending | reached | missed
  billing_percent numeric(5,2),                         -- optional → % of contract to bill on reach
  reached_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pmilestone_project ON project_milestones (project_id);
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

-- 0401_task_dependencies_calendar — PPM-B1 (docs/44): richer scheduling — SS/FF/SF dependency types + lag/lead,
-- start/finish constraints (SNET/FNLT), and an opt-in working calendar (control PROJ-21). Extends the
-- existing CPM schedule() (projects-evm.service.ts) — additive, zero regression:
--   • project_task_dependencies — per-edge scheduling metadata (dep_type, lag_days). A predecessor/successor
--     pair with NO row here still schedules as plain FS/lag-0, exactly the pre-PPM-B1 behaviour, so every
--     existing project's schedule is byte-identical unless a task explicitly declares a richer dependency.
--   • project_tasks.constraint_type/constraint_offset_days — an optional SNET/FNLT floor/ceiling on the
--     forward/backward CPM pass, null (default) = unconstrained, unchanged behaviour.
--   • project_calendars/project_calendar_exceptions — a per-tenant working-day calendar, DISABLED by
--     default; the schedule's duration calculation only skips non-working weekdays/holidays when a tenant
--     explicitly enables it.
-- Tenant-scoped (0232 RLS). Migration number is the next free 4-digit id.

ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS constraint_type text;            -- null | SNET | FNLT
--> statement-breakpoint
ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS constraint_offset_days integer;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS project_task_dependencies (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  project_id bigint NOT NULL REFERENCES projects(id),
  predecessor_task_id bigint NOT NULL REFERENCES project_tasks(id),
  successor_task_id bigint NOT NULL REFERENCES project_tasks(id),
  dep_type text NOT NULL DEFAULT 'FS',   -- FS | SS | FF | SF
  lag_days integer NOT NULL DEFAULT 0,   -- negative = lead
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ptaskdep_successor ON project_task_dependencies (tenant_id, successor_task_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ptaskdep_project ON project_task_dependencies (tenant_id, project_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_ptaskdep_edge ON project_task_dependencies (tenant_id, predecessor_task_id, successor_task_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS project_calendars (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  enabled boolean NOT NULL DEFAULT false,
  non_working_weekdays text NOT NULL DEFAULT '0,6',  -- CSV, 0=Sun..6=Sat
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_pcal_tenant ON project_calendars (tenant_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS project_calendar_exceptions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  exception_date date NOT NULL,
  description text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pcalexc_tenant ON project_calendar_exceptions (tenant_id, exception_date);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_pcalexc_date ON project_calendar_exceptions (tenant_id, exception_date);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) for the three new
-- tables. Idempotent; runs on PGlite + Postgres alike.
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

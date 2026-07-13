-- 0404_project_etc — PPM-B2 (docs/44): bottom-up cost-to-complete (ETC) entry + independent EAC scenarios
-- (control PROJ-22). Extends the existing evm() closed-form EAC (`ac + (bac-ev)/cpi`, formulaic) with an
-- OPTIONAL, per-task manual estimate-to-complete that management can enter directly — additive, zero
-- regression: a project with no project_etc rows computes evm()/eac-scenarios exactly as before (the
-- bottom-up figure simply reads "not available").
--   • project_etc — an append-only log of dated ETC entries per task (or project-level when task_id is
--     null); the CURRENT bottom-up estimate for a task is its latest row. History preserved (never
--     overwritten), mirroring the project_baselines audit pattern.
-- Tenant-scoped (0232 RLS). Migration number is the next free 4-digit id.

CREATE TABLE IF NOT EXISTS project_etc (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  project_id bigint NOT NULL REFERENCES projects(id),
  task_id bigint REFERENCES project_tasks(id),   -- null = project-level (not tied to one task)
  etc_amount numeric(18,2) NOT NULL,
  note text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_petc_project ON project_etc (tenant_id, project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_petc_task ON project_etc (tenant_id, task_id);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) for the new table.
-- Idempotent; runs on PGlite + Postgres alike.
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

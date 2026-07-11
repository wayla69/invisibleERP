-- 0323_hcm_lifecycle — HR-5 (docs/42 HCM depth): employee onboarding / offboarding lifecycle
-- (joiner-mover-leaver). Four tenant-scoped tables:
--   onboarding_templates       — per-tenant checklist template (kind onboarding|offboarding).
--   onboarding_template_tasks  — ordered tasks on a template; is_access_revocation flags an access-removal task.
--   employee_lifecycle         — a template instantiated for one employee (emp_code), status in_progress|complete|blocked.
--   employee_lifecycle_tasks   — the per-employee copy of the template tasks (pending|done|skipped).
-- The HR-05 control lives at completion: an OFFBOARDING lifecycle cannot be marked complete while any task
-- flagged is_access_revocation is still pending (ACCESS_REVOCATION_INCOMPLETE) — the SOX access-removal
-- control. Each table gets a leading (tenant_id, …) index and the CANONICAL 0232-form tenant_isolation RLS
-- policy (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS onboarding_templates (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'onboarding',
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_onb_tpl_tenant ON onboarding_templates (tenant_id, code);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_onb_tpl_code ON onboarding_templates (tenant_id, code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS onboarding_template_tasks (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  template_id bigint NOT NULL REFERENCES onboarding_templates(id),
  seq integer NOT NULL DEFAULT 1,
  title text NOT NULL,
  owner_role text,
  category text NOT NULL DEFAULT 'docs',
  is_access_revocation boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_onb_tpl_task_tpl ON onboarding_template_tasks (tenant_id, template_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS employee_lifecycle (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  emp_code text NOT NULL,
  template_id bigint REFERENCES onboarding_templates(id),
  kind text NOT NULL DEFAULT 'onboarding',
  status text NOT NULL DEFAULT 'in_progress',
  started_at timestamptz DEFAULT now(),
  completed_at timestamptz,
  started_by text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_emp_lifecycle_emp ON employee_lifecycle (tenant_id, emp_code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS employee_lifecycle_tasks (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  lifecycle_id bigint NOT NULL REFERENCES employee_lifecycle(id),
  seq integer NOT NULL DEFAULT 1,
  title text NOT NULL,
  category text NOT NULL DEFAULT 'docs',
  is_access_revocation boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending',
  done_by text,
  done_at timestamptz,
  notes text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_emp_lifecycle_task_lc ON employee_lifecycle_tasks (tenant_id, lifecycle_id);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the four new
-- tables get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

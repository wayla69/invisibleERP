-- 0411_project_phase_gates — PPM Wave P4 phase-gate governance (control PROJ-26).
-- A stage-gate over a project's lifecycle: a project advances through ordered PHASES (concept → planning →
-- execution → closeout → closed) only through a GATE that must be independently authorised. A gate is
-- SUBMITTED for review (pending) with the target phase + readiness notes, then an INDEPENDENT reviewer
-- records a GO / HOLD / KILL decision (decider <> submitter → SOD_SELF_APPROVAL). A GO advances the project
-- to the gate's target phase (the current phase = the latest GO gate's target). Prevents a project rolling
-- from one phase to the next — or continuing to consume capital — with no documented authorisation.
-- One tenant table (0232 canonical RLS, tenant-leading index).

CREATE TABLE IF NOT EXISTS project_phase_gates (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  project_id bigint NOT NULL REFERENCES projects(id),
  gate_key text NOT NULL,                          -- e.g. G1_PLANNING (free-form label)
  name text,
  target_phase text NOT NULL,                      -- planning | execution | closeout | closed
  from_phase text NOT NULL,                        -- the current phase at submit time (audit)
  status text NOT NULL DEFAULT 'pending',          -- pending | go | hold | kill
  readiness text,                                  -- the submitter's readiness note / exit-criteria evidence
  submitted_by text NOT NULL,
  submitted_at timestamptz DEFAULT now(),
  decided_by text,                                 -- reviewer — must differ from submitted_by (SoD)
  decided_at timestamptz,
  decision_notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_phase_gates_tenant ON project_phase_gates (tenant_id, project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_phase_gates_project ON project_phase_gates (project_id, status);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
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

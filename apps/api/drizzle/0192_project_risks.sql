-- 0192_project_risks — project risk & issue register (PPM next-level B4, docs/20; control PROJ-08). One row is
-- either a risk (a future threat, scored probability × impact) or an issue (a materialised problem, scored by
-- impact/severity). RAG status, owner, mitigation and a due date drive governance: an open HIGH risk that is
-- unmitigated is surfaced (not buried) for review at close. Tenant-scoped → re-run the RLS loop (idempotent).
CREATE TABLE IF NOT EXISTS project_risks (
  id bigserial PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES projects(id),
  tenant_id bigint REFERENCES tenants(id),
  kind text NOT NULL DEFAULT 'risk',                   -- risk | issue
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open',                 -- open | mitigating | closed
  probability integer,                                 -- 1..5 (risks; null for issues)
  impact integer NOT NULL DEFAULT 1,                   -- 1..5
  score integer NOT NULL DEFAULT 1,                    -- 1..25 (prob×impact for risk; 5×impact for issue)
  rag text NOT NULL DEFAULT 'green',                   -- red | amber | green (derived from score)
  owner text,
  mitigation text,                                     -- mitigation / resolution plan
  due_date date,
  created_by text,
  created_at timestamptz DEFAULT now(),
  closed_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_prisk_project ON project_risks (project_id);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id table is isolation-scoped (idempotent — DROP POLICY IF EXISTS).
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

-- 0195_project_change_orders — governed contract/scope amendments (PPM upgrade, control PROJ-10). A change
-- order is a REQUEST that posts nothing; a DIFFERENT user must approve it (maker-checker), which applies the
-- contract/budget/EAC deltas to the project and auto-captures a new baseline (ties to PROJ-07) so the
-- goalposts can't move silently or self-served. Tenant-scoped → re-run the RLS loop (idempotent).
CREATE TABLE IF NOT EXISTS project_change_orders (
  id bigserial PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES projects(id),
  tenant_id bigint REFERENCES tenants(id),
  co_no text NOT NULL,
  description text,
  contract_delta numeric(16,2) NOT NULL DEFAULT 0,   -- change to contract value (+/-)
  budget_delta numeric(16,2) NOT NULL DEFAULT 0,
  estimated_cost_delta numeric(16,2) NOT NULL DEFAULT 0,
  reason text,
  status text NOT NULL DEFAULT 'pending',            -- pending | approved | rejected
  requested_by text,
  approved_by text,                                  -- checker — must differ from requested_by
  created_at timestamptz DEFAULT now(),
  approved_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pco_project ON project_change_orders (project_id);
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

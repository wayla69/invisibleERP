-- 0464_mi_budget_plans
-- Marketing Intelligence Budget Optimizer (docs/60 Phase 1). A prescriptive MMM allocation the planner
-- STAGES for approval — advisory only; it never posts spend or moves GL. Maker-checker (control MKT-17):
-- the approver (approved_by) must differ from the requester (requested_by), enforced in the service via
-- assertMakerChecker.
--
-- Tenancy: tenant-scoped — carries tenant_id and gets the CANONICAL 0232-form org-scoped tenant_isolation
-- policy from the trailing DO block, plus a LEADING (tenant_id, …) index (the cutover:tenant-idx gate
-- requires one). Read/plan model only — no GL posting.

CREATE TABLE IF NOT EXISTS mi_budget_plans (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  plan_no text NOT NULL,                               -- BP-YYYYMMDD-NNN
  total_budget numeric NOT NULL,
  allocation jsonb NOT NULL DEFAULT '{}'::jsonb,        -- { channel: spend }
  predicted_sales numeric,                             -- predicted incremental sales for the allocation
  basis text,                                          -- MMM model_run_ref the curves came from, or 'derived'
  status text NOT NULL DEFAULT 'Pending',              -- Pending | Approved | Rejected
  note text,
  requested_by text,
  approved_by text,
  created_at timestamptz DEFAULT now(),
  decided_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mi_budget_plans_tenant ON mi_budget_plans (tenant_id, status, created_at);
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

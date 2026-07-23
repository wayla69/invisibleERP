-- docs/57 Track B (B3) — DC-shortage allocation governance (control SCM-06 / SoD R25).
--
-- scm_allocation_policies: the APPROVED per-DC fair-share method (proportional / fair_share / priority,
--   §1.5). Set/changed under `scm_allocate`, approved by a DIFFERENT `scm_approve` holder (maker ≠
--   approver, enforced by assertMakerChecker — never the schema). Absent ⇒ proportional default.
-- scm_allocation_overrides: a planner-entered override of a plan's computed fair-share — rejected unless
--   a justification is recorded (ALLOCATION_OVERRIDE_UNLOGGED) AND staged for a SECOND approver (never
--   auto-applied). The two-person control so no branch is quietly favoured.
--
-- Tenancy: both carry tenant_id, so the trailing DO block's CANONICAL 0232-form org loop enables
-- tenant_isolation; the leading (tenant_id, …) indexes satisfy the cutover:tenant-idx gate. Only the
-- scm-network module writes them (no cross-writer NULL-tenant fan-out to sweep).
CREATE TABLE IF NOT EXISTS scm_allocation_policies (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  dc_node_code text NOT NULL,                         -- → supply_nodes.node_code (a DC / central kitchen)
  method text NOT NULL DEFAULT 'proportional',        -- 'proportional' | 'fair_share' | 'priority'
  priorities jsonb NOT NULL DEFAULT '{}'::jsonb,       -- { [branch_node_code]: weight }
  status text NOT NULL DEFAULT 'PendingApproval',     -- PendingApproval | Approved | Rejected
  reason text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  submitted_by text,                                  -- the maker (bound as maker for SoD R25)
  approved_by text,
  approved_at timestamptz,
  reject_reason text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_allocation_policies_tenant ON scm_allocation_policies (tenant_id, dc_node_code);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS scm_allocation_overrides (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  plan_id bigint NOT NULL REFERENCES scm_network_plans(id),
  proposed jsonb NOT NULL DEFAULT '[]'::jsonb,        -- the override allocation lines the maker proposes
  justification text NOT NULL,                        -- mandatory — an unlogged override is rejected
  status text NOT NULL DEFAULT 'PendingApproval',     -- PendingApproval | Approved | Rejected
  requested_by text,                                  -- the maker (bound as maker for SoD R25)
  requested_at timestamptz DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  reject_reason text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_allocation_overrides_tenant ON scm_allocation_overrides (tenant_id, plan_id);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
--
-- EXCLUDES `audit_expectations` (migration 0465): it carries a tenant_id column so this generic loop
-- would sweep it in, but its tenant_isolation policy is DELIBERATELY permissive — re-scoping it here
-- 500s every god act-as mutation (25P02; see CLAUDE.md + migration 0470). Keep this exclusion in any
-- migration that copies this loop.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name <> 'audit_expectations' LOOP
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

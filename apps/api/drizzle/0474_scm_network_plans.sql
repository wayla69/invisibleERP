-- docs/57 Track B (B2b) — two-echelon network replenishment PLAN persistence.
--
-- scm_network_plans (one plan per item across the whole network) + scm_network_plan_lines (one row per
-- STOCKING node — DC + branches; the supplier has no base-stock). Same Draft→PendingApproval→Approved→
-- Converted maker-checker lifecycle as scm_order_plans; approvedBy MUST differ from the maker (control
-- SCM-05), enforced in the service, never the schema. Only an Approved plan rolls up to a PR through the
-- existing ProcurementService.createPr seam (idempotent by pr_no).
--
-- Tenancy: both carry tenant_id, so the trailing DO block's CANONICAL 0232-form org loop enables
-- tenant_isolation; the leading (tenant_id, …) indexes satisfy the cutover:tenant-idx gate. Only the
-- scm-network run writes them (no cross-writer NULL-tenant fan-out to sweep).
CREATE TABLE IF NOT EXISTS scm_network_plans (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  plan_no text NOT NULL,                              -- SCMN-YYYYMMDD-NNN
  item_code text NOT NULL,
  horizon_days integer,
  service_level numeric(5,4),
  allocation_method text NOT NULL DEFAULT 'proportional',
  status text NOT NULL DEFAULT 'Draft',
  engine text NOT NULL DEFAULT 'fallback',            -- 'engine' (GSM) | 'fallback' (in-process)
  pooling_benefit_pct numeric(8,3),
  independent_safety_units numeric(18,4),
  pooled_safety_units numeric(18,4),
  est_total_cost numeric(18,2) NOT NULL DEFAULT 0,
  allocations jsonb NOT NULL DEFAULT '[]'::jsonb,     -- fair-share lines on a projected DC shortage
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  submitted_by text,
  submitted_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  reject_reason text,
  pr_no text,
  converted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_network_plans_tenant ON scm_network_plans (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_network_plans_no ON scm_network_plans (tenant_id, plan_no);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS scm_network_plan_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  plan_id bigint NOT NULL REFERENCES scm_network_plans(id),
  node_code text NOT NULL,                            -- → supply_nodes.node_code (this tenant)
  echelon integer NOT NULL,                           -- 1 DC · 2 branch
  service_time_out_days numeric(8,2) NOT NULL DEFAULT 0,
  base_stock jsonb NOT NULL DEFAULT '[]'::jsonb,                  -- per horizon day — echelon base-stock
  installation_base_stock jsonb NOT NULL DEFAULT '[]'::jsonb,     -- per horizon day — installation
  safety_stock jsonb NOT NULL DEFAULT '[]'::jsonb,               -- per horizon day
  orders jsonb NOT NULL DEFAULT '[]'::jsonb,          -- [{order_ds, arrival_ds, from_node, qty, packs}]
  expected_fill_rate numeric(6,4),
  expected_waste_cost numeric(18,2),
  order_qty numeric(18,4) NOT NULL DEFAULT 0,         -- Σ order qty (clamped)
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scm_network_plan_lines_tenant ON scm_network_plan_lines (tenant_id, plan_id);
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

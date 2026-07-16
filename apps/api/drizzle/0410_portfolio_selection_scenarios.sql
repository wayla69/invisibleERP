-- 0410_portfolio_selection_scenarios — PPM Wave P4 portfolio governance (control PROJ-25).
-- A portfolio SELECTION scenario: a named what-if that models which candidate projects to fund within a
-- budget ENVELOPE, each candidate carrying an include/exclude decision + a priority score. A scenario is
-- DRAFT (freely editable) until it is COMMITTED — a maker-checker decision (committer <> author →
-- SOD_SELF_APPROVAL) that locks the authorised GO-set. A commit whose included budget exceeds the envelope
-- is rejected (OVER_ENVELOPE) unless an exec explicitly overrides with a reason. Read-only aggregation over
-- the existing projects spine (contract/budget/estimated-cost) — no project row is mutated.
-- Two tenant tables (0232 canonical RLS, tenant-leading indexes).

CREATE TABLE IF NOT EXISTS portfolio_scenarios (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  scenario_no text NOT NULL,                       -- PSC-#### per tenant
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',            -- draft | committed
  budget_envelope numeric(18,2),                   -- funding ceiling the included budget is checked against (null = no ceiling)
  objective text,
  notes text,
  override_reason text,                            -- set when committed over the envelope (exec override)
  created_by text NOT NULL,
  committed_by text,
  committed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_portfolio_scenario_no ON portfolio_scenarios (tenant_id, scenario_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_portfolio_scenarios_tenant ON portfolio_scenarios (tenant_id, status);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS portfolio_scenario_items (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  scenario_id bigint NOT NULL REFERENCES portfolio_scenarios(id),
  project_id bigint NOT NULL REFERENCES projects(id),
  decision text NOT NULL DEFAULT 'include',        -- include | exclude
  priority_score numeric(6,2) NOT NULL DEFAULT 0,  -- higher = higher priority
  rationale text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_portfolio_scenario_item ON portfolio_scenario_items (tenant_id, scenario_id, project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_portfolio_scenario_items_tenant ON portfolio_scenario_items (tenant_id, scenario_id);
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

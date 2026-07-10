-- 0298_budget_control_encumbrance — Budgetary control / encumbrance gate on procurement (FIN-3, BUD-02).
-- (1) budget_control_settings: per-tenant policy for the PR/PO approval budget gate — 'off' (default,
-- report-only = pre-FIN-3 behaviour) | 'advise' | 'warn' | 'block' — plus the default expense account used
-- when a line's item resolves no budget account (item.cogs_account → item_categories.cogs_account → this).
-- (2) budget_commitments: the GL-budget commitment/encumbrance ledger for NON-project procurement (the
-- project/BoQ twin is project_commitments). A PR approval reserves its estimated spend; a PO approval
-- reserves the ordered amount (releasing the PR's reservation at conversion); receipt consumes, cancel/
-- close-short releases. Availability = approved budget (YTD) − GL actuals (YTD) − open commitments.
-- Over-budget exec overrides are audited on the row (over_budget + override_by/override_reason).
CREATE TABLE IF NOT EXISTS budget_control_settings (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  policy text NOT NULL DEFAULT 'off',
  default_expense_account text NOT NULL DEFAULT '5000',
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_budget_ctrl_settings_tenant ON budget_control_settings (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS budget_commitments (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  fiscal_year integer NOT NULL,
  period text NOT NULL,
  account_code text NOT NULL,
  cost_center_code text,
  source_doc_type text NOT NULL,
  source_doc_no text NOT NULL,
  amount numeric(18,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  over_budget boolean NOT NULL DEFAULT false,
  override_by text,
  override_reason text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_budget_commit_account ON budget_commitments (tenant_id, account_code, period);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_budget_commit_source ON budget_commitments (source_doc_type, source_doc_no);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new tables
-- get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

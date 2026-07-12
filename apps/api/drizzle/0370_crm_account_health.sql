-- 0370_crm_account_health — CRM-15 (B2B account health / churn + renewal-expansion pipeline, control CRM-08).
-- A read-mostly detective layer on the REV-17 CRM spine (no change to lead→convert→opportunity). Two additions:
--   • crm_opportunities.deal_type — tags a deal new | renewal | expansion, so renewal/expansion revenue is a
--     tracked forward pipeline (and an account with a won deal but NO open renewal is a churn-gap flag).
--   • crm_account_health_snapshots — a persisted per-account health SCORE + band (mirrors project_health_
--     snapshots): a schedulable daily snapshot for the churn watchlist + trend. Tenant-scoped (0232 RLS).
-- Also indexes service_cases by (tenant_id, account_id) for the per-account open/escalated/breached case count.
-- The migration number is buffered ahead of the concurrently-hot revrec/ledger migration sequence.

ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS deal_type text NOT NULL DEFAULT 'new'; -- new | renewal | expansion
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_service_cases_account ON service_cases (tenant_id, account_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS crm_account_health_snapshots (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  account_id bigint NOT NULL REFERENCES crm_accounts(id),
  snapshot_date date NOT NULL,
  score integer NOT NULL DEFAULT 0,          -- 0..100 (100 = healthiest)
  band text NOT NULL DEFAULT 'no_data',      -- healthy | watch | at_risk | no_data
  signals jsonb NOT NULL DEFAULT '{}'::jsonb, -- the per-factor breakdown snapshot
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_acct_health_day ON crm_account_health_snapshots (tenant_id, account_id, snapshot_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_acct_health_account ON crm_account_health_snapshots (tenant_id, account_id);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new table
-- gets RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

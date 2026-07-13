-- 0378_crm_forecast — CRM-12 (sales forecasting depth, control CRM-09).
-- A governance layer over the REV-17 pipeline forecast (crm_pipeline analytics/forecast). Two additions, both
-- read-mostly over crm_opportunities (no change to the lead→convert→opportunity paths, no GL post):
--   • crm_forecast_submissions — a rep→manager manual OVERRIDE: per (period, owner) a rep submits their own
--     commit / best-case number; the manager roll-up reconciles it against the system-weighted forecast so an
--     unsubmitted or over-optimistic rep number surfaces. Governed status draft → submitted.
--   • crm_forecast_snapshots — a dated, immutable period SNAPSHOT of the forecast (commit / best-case /
--     pipeline / weighted + open count) plus the period's actual won, so forecast-vs-actual ACCURACY and
--     pipeline-coverage are tracked over time (schedulable via the BI report crm_forecast_snapshot; idempotent
--     per period/day, mirrors crm_account_health_snapshots).
-- Tenant-scoped (0232 RLS). The migration number is buffered ahead of the concurrently-hot migration sequence.

CREATE TABLE IF NOT EXISTS crm_forecast_submissions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  period text NOT NULL,                        -- 'YYYY-MM' (business month, Asia/Bangkok)
  owner text NOT NULL,                         -- the rep (crm_opportunities.owner); manager roll-up groups by this
  commit_amount numeric(14,2) NOT NULL DEFAULT '0',
  best_case_amount numeric(14,2) NOT NULL DEFAULT '0',
  pipeline_amount numeric(14,2) NOT NULL DEFAULT '0',
  status text NOT NULL DEFAULT 'draft',        -- draft | submitted
  notes text,
  submitted_by text,
  submitted_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_fc_sub_period_owner ON crm_forecast_submissions (tenant_id, period, owner);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_fc_sub_period ON crm_forecast_submissions (tenant_id, period);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS crm_forecast_snapshots (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  period text NOT NULL,                        -- 'YYYY-MM'
  snapshot_date date NOT NULL,
  forecast_amount numeric(14,2) NOT NULL DEFAULT '0',   -- commit (full) + best-case (weighted) + pipeline (weighted)
  commit_amount numeric(14,2) NOT NULL DEFAULT '0',
  best_case_amount numeric(14,2) NOT NULL DEFAULT '0',
  pipeline_amount numeric(14,2) NOT NULL DEFAULT '0',
  weighted_amount numeric(14,2) NOT NULL DEFAULT '0',   -- Σ amount × probability across all open deals in the period
  open_count integer NOT NULL DEFAULT 0,
  actual_won_amount numeric(14,2) NOT NULL DEFAULT '0', -- won in the period as of the snapshot date (accuracy input)
  submitted_total numeric(14,2) NOT NULL DEFAULT '0',   -- Σ submitted rep commit for the period (roll-up target)
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_fc_snap_day ON crm_forecast_snapshots (tenant_id, period, snapshot_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_fc_snap_period ON crm_forecast_snapshots (tenant_id, period);
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

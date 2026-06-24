-- 0081 — Scheduled-report execution engine + saved views (Platform Phase 4).
-- (a) report_runs: history of every scheduled-report execution (the existing report_subscriptions table
--     stored a schedule but nothing ever ran it; this completes the loop — a cron-callable sweep generates
--     the report, delivers it (in-app notification + email), records a run here, and advances the schedule).
-- (b) saved_views: per-user, per-module saved filter/column presets (personal or shared within the tenant).
-- Both carry tenant_id → re-run the 0002 RLS loop so they are isolation-scoped.

CREATE TABLE IF NOT EXISTS report_runs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  subscription_id bigint,                 -- source report_subscriptions.id (null for ad-hoc)
  name text,
  report_type text,                       -- kpi_board | sales_cube | finance_trend | pipeline_trend
  frequency text,
  status text NOT NULL DEFAULT 'success', -- success | failed
  recipients_count integer NOT NULL DEFAULT 0,
  summary jsonb DEFAULT '{}'::jsonb,       -- the generated report payload (or {} on failure)
  error text,
  ran_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_report_runs_scope ON report_runs (tenant_id, ran_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS saved_views (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  owner text NOT NULL,                     -- username that owns the view
  module text NOT NULL,                    -- list screen key, e.g. 'inventory' | 'orders' | 'vendors'
  name text NOT NULL,
  config jsonb DEFAULT '{}'::jsonb,         -- {filter:{...}, sort:'...', columns:[...]}
  shared boolean NOT NULL DEFAULT false,   -- visible to the whole tenant when true
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_saved_views_scope ON saved_views (tenant_id, module);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id tables are isolation-scoped.
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

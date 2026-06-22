-- 0036_planning: EPM Planning & Budgeting (xP&A) — budget_versions, budget_scenarios,
--               budget_drivers, forecast_lines. No GL entries — off-ledger planning tables.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS budget_versions (
  id           bigserial PRIMARY KEY,
  tenant_id    bigint REFERENCES tenants(id),
  version_no   text NOT NULL,
  name         text NOT NULL,
  fiscal_year  int  NOT NULL,
  status       text NOT NULL DEFAULT 'Working',
  notes        text,
  created_by   text,
  submitted_at timestamptz,
  approved_at  timestamptz,
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now(),
  UNIQUE(tenant_id, version_no)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_budver_tenant ON budget_versions(tenant_id, fiscal_year);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS budget_scenarios (
  id          bigserial PRIMARY KEY,
  tenant_id   bigint REFERENCES tenants(id),
  version_id  bigint NOT NULL REFERENCES budget_versions(id),
  name        text NOT NULL,
  description text,
  is_default  boolean DEFAULT false,
  created_at  timestamptz DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_budscen_version ON budget_scenarios(version_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS budget_drivers (
  id           bigserial PRIMARY KEY,
  tenant_id    bigint REFERENCES tenants(id),
  scenario_id  bigint NOT NULL REFERENCES budget_scenarios(id),
  account_code text NOT NULL,
  driver_type  text NOT NULL,
  rate_value   numeric(10,4) NOT NULL,
  notes        text,
  created_at   timestamptz DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_buddrv_scenario ON budget_drivers(scenario_id, account_code);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forecast_lines (
  id               bigserial PRIMARY KEY,
  tenant_id        bigint REFERENCES tenants(id),
  scenario_id      bigint NOT NULL REFERENCES budget_scenarios(id),
  account_code     text NOT NULL,
  cost_center_code text,
  period           text NOT NULL,
  amount           numeric(18,4) NOT NULL DEFAULT 0,
  source           text NOT NULL DEFAULT 'Manual',
  notes            text,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  UNIQUE(scenario_id, account_code, period)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fcst_scenario_period ON forecast_lines(scenario_id, period);

--> statement-breakpoint
-- RLS for all new scoped tables (string-concat pattern — PGlite cannot parse nested dollar-quoting)
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='tenant_id'
      AND table_name IN ('budget_versions','budget_scenarios','budget_drivers','forecast_lines')
  LOOP
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

-- Phase D4 — demand forecast runs (demand ML). Persists each forecast run with the chosen algorithm,
-- hold-out accuracy metrics (WAPE/MASE/RMSE/bias) and the horizon point forecasts. Tenant-scoped.
CREATE TABLE IF NOT EXISTS demand_forecasts (
  id          bigserial PRIMARY KEY,
  tenant_id   bigint REFERENCES tenants(id),
  item_id     text NOT NULL,
  algorithm   text NOT NULL,            -- sma | ses | holt | seasonal_naive | croston
  selected_by text,                     -- lowest_wape | requested
  horizon     integer NOT NULL,
  data_days   integer,
  wape        numeric(10,4),
  mase        numeric(10,4),
  rmse        numeric(14,4),
  bias        numeric(14,4),
  forecast    jsonb NOT NULL,           -- number[] horizon point forecasts
  created_by  text,
  created_at  timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_demand_forecasts_tenant ON demand_forecasts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_demand_forecasts_item ON demand_forecasts(tenant_id, item_id, created_at);
--> statement-breakpoint
-- Re-run the dynamic RLS loop so the new tenant_id table (demand_forecasts) is isolated like every other.
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

-- 0112 — Enterprise Asset Management (EAM): maintenance work orders, preventive-maintenance schedules,
-- and asset meter readings on top of the fixed-asset register. New tenant_id tables → RLS loop re-run.
CREATE TABLE IF NOT EXISTS maintenance_work_orders (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  wo_no text NOT NULL,
  asset_id bigint REFERENCES fixed_assets(id),
  asset_no text,
  type text NOT NULL DEFAULT 'corrective',
  priority text DEFAULT 'medium',
  status text NOT NULL DEFAULT 'open',
  description text,
  scheduled_date date,
  started_at timestamptz,
  completed_date date,
  vendor_name text,
  cost_estimate numeric(14,2) DEFAULT 0,
  actual_cost numeric(14,2) DEFAULT 0,
  downtime_hours numeric(10,2) DEFAULT 0,
  meter_reading numeric(18,2),
  ap_txn_no text,
  pm_schedule_id bigint,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_mwo_no ON maintenance_work_orders (tenant_id, wo_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mwo_asset ON maintenance_work_orders (asset_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mwo_status ON maintenance_work_orders (status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pm_schedules (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  asset_id bigint REFERENCES fixed_assets(id),
  asset_no text,
  name text NOT NULL,
  interval_days bigint,
  meter_interval numeric(18,2),
  last_service_date date,
  last_service_meter numeric(18,2) DEFAULT 0,
  next_due_date date,
  active text DEFAULT 'true',
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pm_asset ON pm_schedules (asset_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS asset_meters (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  asset_id bigint REFERENCES fixed_assets(id),
  asset_no text,
  reading_date date,
  meter_value numeric(18,2) NOT NULL,
  note text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_meter_asset ON asset_meters (asset_id);
--> statement-breakpoint
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

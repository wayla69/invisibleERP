-- 0046 — Module enable/disable flags + Asset/Inventory QR.
-- module_configs is GLOBAL (no tenant_id → no RLS): a platform-wide feature switch
-- mirroring the legacy ERPPOS tbl_module_config. module_key == permission key.
CREATE TABLE IF NOT EXISTS module_configs (
  module_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz DEFAULT now(),
  updated_by text
);
--> statement-breakpoint

-- Physical-tracking columns on fixed_assets (QR asset tags + scan-to-locate).
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS location text;--> statement-breakpoint
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS department text;--> statement-breakpoint
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS serial_no text;--> statement-breakpoint
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS assigned_to text;--> statement-breakpoint

-- Audit trail of physical asset moves (location/status changes via QR scan).
CREATE TABLE IF NOT EXISTS asset_movements (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  asset_id bigint REFERENCES fixed_assets(id),
  asset_no text,
  move_date timestamptz DEFAULT now(),
  move_type text,
  from_location text,
  to_location text,
  from_status text,
  to_status text,
  note text,
  by_user text
);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so asset_movements (new tenant_id table) is isolation-scoped.
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

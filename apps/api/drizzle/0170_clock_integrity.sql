-- Step 9 — anti-buddy-punch clock-in integrity. The time clock guarded only against a second OPEN punch;
-- it could not tell HOW a punch was made, WHERE, or stop a rapid re-punch (one worker clocking a colleague
-- in). This adds the capture method + geofence coordinates on time_clock and a geofence_zones table so a
-- branch can require punches inside a radius; the service rejects a duplicate punch within a short window
-- and a supervisor override is recorded (audit-logged). time_clock already has tenant_id + RLS, so its
-- additive columns need no loop; geofence_zones is a new tenant table → RLS loop appended below.
ALTER TABLE time_clock ADD COLUMN IF NOT EXISTS clock_in_method text NOT NULL DEFAULT 'PIN';  -- PIN | QR | FACE_HASH | SUPERVISOR
--> statement-breakpoint
ALTER TABLE time_clock ADD COLUMN IF NOT EXISTS clock_in_lat numeric(9,6);
--> statement-breakpoint
ALTER TABLE time_clock ADD COLUMN IF NOT EXISTS clock_in_lng numeric(9,6);
--> statement-breakpoint
ALTER TABLE time_clock ADD COLUMN IF NOT EXISTS geofence_pass boolean;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS geofence_zones (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  branch_id bigint,
  lat numeric(9,6) NOT NULL,
  lng numeric(9,6) NOT NULL,
  radius_m integer NOT NULL DEFAULT 150,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_geofence_zone UNIQUE (tenant_id, branch_id)
);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id table is isolation-scoped (idempotent — DROP POLICY IF EXISTS).
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

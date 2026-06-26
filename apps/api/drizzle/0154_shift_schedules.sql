-- W4 — Shift schedule / roster. A planned shift for a staff member; the labor summary sums scheduled
-- hours × rate, compares to sales (labor % of sales) and to actual punched hours (time_clock). Operational
-- scheduling — no GL.
CREATE TABLE IF NOT EXISTS shift_schedules (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  emp_code text NOT NULL,
  shift_date text NOT NULL,
  start_time text NOT NULL,
  end_time text NOT NULL,
  hours numeric(8,2) NOT NULL DEFAULT 0,
  hourly_rate numeric(12,2) NOT NULL DEFAULT 0,
  position text,
  status text NOT NULL DEFAULT 'scheduled',
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_shift_schedules_date ON shift_schedules (tenant_id, shift_date);
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

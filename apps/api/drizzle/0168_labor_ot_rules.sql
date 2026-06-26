-- Step 8 — tiered OT rules engine + labor-% alerts. overtimePay was a flat 1.5× with no holiday/night tiers
-- and no caps, and laborSummary reported labor % of sales but never alerted. labor_ot_rules holds the
-- per-tenant override of the Thai LPA multipliers + daily/weekly trigger hours (defaults in code: REGULAR_OT
-- 1.5×, HOLIDAY 2×, HOLIDAY_OT 3×, NIGHT 1.0×; 8h/day, 48h/week); labor_alerts records a fired
-- labor-%-exceeded alert per period so a manager can act. Both tenant-scoped → RLS loop appended below.
CREATE TABLE IF NOT EXISTS labor_ot_rules (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  rule_type text NOT NULL,                              -- REGULAR_OT | HOLIDAY | HOLIDAY_OT | NIGHT
  multiplier numeric(4,2) NOT NULL DEFAULT 1.5,
  daily_trigger_hours integer NOT NULL DEFAULT 8,
  weekly_trigger_hours integer NOT NULL DEFAULT 48,
  effective_from text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_labor_ot_rule UNIQUE (tenant_id, rule_type)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS labor_alerts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  branch_id bigint,
  period_from text,
  period_to text,
  alert_type text NOT NULL,                             -- LABOR_PCT_EXCEEDED | OT_CAP_APPROACHING | SCHEDULE_GAP
  threshold_pct numeric(7,4),
  actual_pct numeric(7,4),
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id tables are isolation-scoped (idempotent — DROP POLICY IF EXISTS).
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

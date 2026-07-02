-- 0212_journeys — Phase G1 (docs/25): lifecycle journeys — linear multi-step drips (wait N days → send
-- channel/body unless a whitelisted skip-rule matches), consent-respecting + frequency-capped sends, and
-- claim-first at-most-once step execution (control MKT-12). Entry: manual/automation action, or a saved-
-- segment sweep. Tenant-scoped on all three tables → re-run the RLS loop (mirrors 0209_saved_segments).
CREATE TABLE IF NOT EXISTS journeys (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  trigger text NOT NULL DEFAULT 'manual',
  segment_id bigint REFERENCES saved_segments(id),
  cap_messages integer NOT NULL DEFAULT 0,
  cap_window_days integer NOT NULL DEFAULT 7,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS journeys_tenant_code ON journeys (tenant_id, code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS journey_steps (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  journey_id bigint REFERENCES journeys(id),
  step_no integer NOT NULL,
  wait_days integer NOT NULL DEFAULT 0,
  channel text NOT NULL DEFAULT 'sms',
  body text NOT NULL,
  skip_rule jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS journey_steps_journey_step ON journey_steps (journey_id, step_no);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS journey_enrollments (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  journey_id bigint REFERENCES journeys(id),
  member_id bigint REFERENCES pos_members(id),
  current_step integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  next_run_at timestamptz,
  enrolled_at timestamptz DEFAULT now(),
  last_step_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS journey_enrollments_journey_member ON journey_enrollments (journey_id, member_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS journey_enrollments_due ON journey_enrollments (tenant_id, status, next_run_at);
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

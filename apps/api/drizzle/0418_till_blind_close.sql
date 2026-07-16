-- 0418_till_blind_close — blind drawer close (docs/50 Wave 1, POS roadmap P1c residual; strengthens REV-13).
-- With blind close ON, the cashier must count the drawer WITHOUT seeing the system-expected cash: the till
-- read surfaces (X/Z report on an OPEN session) redact the drawer-expectation figures for till-duty callers,
-- and expected/variance are revealed only AFTER the count is submitted at close. Per-tenant opt-in policy
-- (one row per tenant, NULL tenant = single-company default — mirrors receiving_settings), plus an evidence
-- stamp on the closed session recording that the close was performed blind.

CREATE TABLE IF NOT EXISTS till_settings (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  blind_close boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_till_settings ON till_settings (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_till_settings_tenant ON till_settings (tenant_id);
--> statement-breakpoint
ALTER TABLE till_sessions ADD COLUMN IF NOT EXISTS blind_close boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
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

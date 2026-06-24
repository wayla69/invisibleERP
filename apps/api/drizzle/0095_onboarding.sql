-- 0095 — E1 (Platform Phase 26) guided onboarding + industry template packs. Tracks per-tenant setup-step
-- completion + which industry packs were applied. New tenant_id tables → RLS loop re-run. No GL.

CREATE TABLE IF NOT EXISTS onboarding_progress (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  step_key text NOT NULL,
  done_at timestamptz DEFAULT now(),
  done_by text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_onboarding_step ON onboarding_progress (tenant_id, step_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pack_installs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  pack_key text NOT NULL,
  version text NOT NULL DEFAULT '1',
  installed_at timestamptz DEFAULT now(),
  installed_by text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_pack_install ON pack_installs (tenant_id, pack_key);
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

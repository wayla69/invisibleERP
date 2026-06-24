-- 0099 — C2 (Platform Phase 21) country localization packs. Records the active country pack per tenant
-- (applying a pack sets the tenant's tax country + default locale). New tenant_id table → RLS loop re-run.
CREATE TABLE IF NOT EXISTS tenant_localization (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  country text NOT NULL,
  version text NOT NULL DEFAULT '1',
  applied_at timestamptz DEFAULT now(),
  applied_by text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_localization ON tenant_localization (tenant_id);
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

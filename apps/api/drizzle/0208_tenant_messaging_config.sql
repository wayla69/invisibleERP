-- 0208_tenant_messaging_config — per-tenant messaging provider credentials (LINE OA / SMS / SMTP).
-- One row per (tenant, channel). Provider secrets are AES-256-GCM encrypted at rest in config_enc
-- (write-only; never returned to the UI). A tenant that sets its own provider overrides the shared platform
-- env default; unset ⇒ env ⇒ mock. Tenant-scoped → re-run the RLS loop. Mirrors 0207_loyalty_receipt_submissions.
CREATE TABLE IF NOT EXISTS tenant_messaging_config (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  channel text NOT NULL,
  config_enc text,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz DEFAULT now(),
  updated_by text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_messaging_channel ON tenant_messaging_config (tenant_id, channel);
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

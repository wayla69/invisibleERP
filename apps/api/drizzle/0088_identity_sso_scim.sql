-- 0088 — Enterprise identity (Platform #4): per-tenant IdP (OIDC) config + SCIM 2.0 provisioning.
-- New tenant_id table tenant_identity → re-run the 0002 RLS loop so it is tenant-isolated. Adds
-- users.is_active so SCIM deprovisioning DEACTIVATES a user (preserves the audit trail) instead of
-- destroying the row. Secrets (OIDC client secret, SCIM bearer token) are stored hashed/encrypted.

CREATE TABLE IF NOT EXISTS tenant_identity (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  sso_enabled boolean NOT NULL DEFAULT false,
  oidc_issuer text,                        -- e.g. https://login.example.com
  oidc_client_id text,
  oidc_client_secret_enc text,             -- AES-256-GCM at rest (used for HS256 id_token verify too)
  oidc_redirect_uri text,
  default_role text NOT NULL DEFAULT 'Customer', -- role assigned to JIT-provisioned SSO users
  scim_enabled boolean NOT NULL DEFAULT false,
  scim_token_hash text,                    -- sha256(scim_<…>); the plaintext is shown once at generation
  scim_token_prefix text,                  -- first 12 chars, for display
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_identity ON tenant_identity (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tenant_identity_scim_prefix ON tenant_identity (scim_token_prefix);
--> statement-breakpoint

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id table is isolation-scoped (mirrors 0078).
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

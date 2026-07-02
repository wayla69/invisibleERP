-- 0226_wallet_pass — docs/29 Phase V5: digital wallet-pass registry (Apple/Google Wallet; mock provider
-- until signing creds are configured). One registration per member×platform (unique) — a re-issue is
-- idempotent. The BiLive loyalty tick bumps updates_count/last_points so the pass tracks the live balance
-- (best-effort presentation layer — no new control). PDPA-minimal: no contact/spend data stored here.
CREATE TABLE IF NOT EXISTS wallet_pass_registrations (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  member_id bigint NOT NULL REFERENCES pos_members(id),
  platform text NOT NULL,
  provider text NOT NULL,
  pass_serial text NOT NULL,
  push_token text,
  status text NOT NULL DEFAULT 'Active',
  updates_count integer NOT NULL DEFAULT 0,
  last_points numeric,
  last_tier text,
  last_update_at timestamptz,
  created_at timestamptz DEFAULT now(),
  created_by text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS wallet_pass_member_platform ON wallet_pass_registrations (member_id, platform);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS wallet_pass_tenant ON wallet_pass_registrations (tenant_id, member_id);
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

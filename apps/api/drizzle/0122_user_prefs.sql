-- 0122 — Per-user UI preferences (sidebar favourites + nav fold-state), synced across devices.
-- One row per (tenant, username); a generic `prefs` jsonb blob keeps it extensible. 'recents' deliberately
-- stays per-device (localStorage) and is NOT stored here. Carries tenant_id → re-run the 0002 RLS loop so
-- it is isolation-scoped.

CREATE TABLE IF NOT EXISTS user_prefs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  owner text NOT NULL,                       -- username that owns the preferences
  prefs jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { favorites: string[], navFold: Record<string, boolean> }
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT user_prefs_tenant_owner_uniq UNIQUE (tenant_id, owner)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_user_prefs_owner ON user_prefs (tenant_id, owner);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id table is isolation-scoped.
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

-- 0105 — CRM Phase 4: member-get-member referrals. New tenant-scoped table (RLS loop re-run).
CREATE TABLE IF NOT EXISTS loyalty_referrals (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  referrer_member_id bigint REFERENCES pos_members(id),
  referred_member_id bigint REFERENCES pos_members(id),
  referred_phone text,
  code text NOT NULL UNIQUE,                       -- RFL-YYYYMMDD-NNN
  status text NOT NULL DEFAULT 'pending',          -- pending | rewarded | void
  referrer_points integer NOT NULL DEFAULT 0,
  referred_points integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  rewarded_at timestamptz,
  created_by text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_referrals_referrer ON loyalty_referrals (referrer_member_id);
--> statement-breakpoint
-- a member can be referred at most once (anti-gaming)
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_referrals_referred_uq ON loyalty_referrals (referred_member_id) WHERE referred_member_id IS NOT NULL;
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

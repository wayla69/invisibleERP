-- 0109 — CRM Phase 4: partner privileges (member perks at partner merchants, tier-gated, single-use claim
-- codes). New tenant_id tables → RLS loop.
CREATE TABLE IF NOT EXISTS loyalty_partners (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  partner_code text NOT NULL,
  name text NOT NULL,
  category text,
  contact text,
  active boolean DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_partners_tenant_code ON loyalty_partners (tenant_id, partner_code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS loyalty_privileges (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  partner_id bigint REFERENCES loyalty_partners(id),
  name text NOT NULL,
  description text,
  kind text NOT NULL DEFAULT 'discount_percent',
  value numeric(14,2) DEFAULT 0,
  tier_min integer,
  stock integer,
  per_member_limit integer,
  valid_from text,
  valid_to text,
  active boolean DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_privileges_partner ON loyalty_privileges (partner_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS loyalty_privilege_claims (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  privilege_id bigint REFERENCES loyalty_privileges(id),
  member_id bigint REFERENCES pos_members(id),
  claim_code text NOT NULL,
  status text NOT NULL DEFAULT 'claimed',
  claimed_at timestamptz DEFAULT now(),
  used_at timestamptz,
  used_at_partner text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_privilege_claims_code ON loyalty_privilege_claims (claim_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_privilege_claims_member ON loyalty_privilege_claims (member_id);
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

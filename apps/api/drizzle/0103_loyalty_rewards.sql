-- 0103 — CRM Phase 2: rewards catalog, point-burn redemptions (single-use codes), member coupon wallet.
-- New tenant-scoped tables (RLS loop re-run). Status/type columns are text (Zod-validated at the API).
CREATE TABLE IF NOT EXISTS loyalty_rewards (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  reward_code text NOT NULL,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'evoucher',          -- evoucher | discount | product | privilege
  point_cost numeric NOT NULL,
  cash_value numeric(14,2) DEFAULT '0',
  coupon_kind text,                               -- percent | amount | free_item
  coupon_value numeric(14,2) DEFAULT '0',
  stock integer,                                  -- null = unlimited
  per_member_limit integer,                       -- null = unlimited
  tier_min numeric,                               -- min lifetime points (null = any)
  valid_from date,
  valid_to date,
  image_key text,
  active boolean DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_rewards_tenant_code ON loyalty_rewards (tenant_id, reward_code);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS loyalty_redemptions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  member_id bigint REFERENCES pos_members(id),
  reward_id bigint REFERENCES loyalty_rewards(id),
  redemption_code text NOT NULL UNIQUE,           -- RDM-YYYYMMDD-NNN
  point_cost numeric NOT NULL,
  reward_name text,
  reward_type text,
  value numeric(14,2) DEFAULT '0',
  status text NOT NULL DEFAULT 'issued',          -- issued | used | expired | void
  issued_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  used_at timestamptz,
  used_ref text,
  created_by text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_redemptions_member ON loyalty_redemptions (member_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_redemptions_tenant_status ON loyalty_redemptions (tenant_id, status);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS member_coupons (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  member_id bigint REFERENCES pos_members(id),
  code text NOT NULL UNIQUE,                       -- CPN-YYYYMMDD-NNN
  kind text NOT NULL,                              -- percent | amount | free_item
  value numeric(14,2) DEFAULT '0',
  source text,                                     -- campaign | birthday | referral | manual | reward
  status text NOT NULL DEFAULT 'active',           -- active | used | expired
  issued_at timestamptz DEFAULT now(),
  expires_at timestamptz,
  used_at timestamptz,
  used_ref text,
  created_by text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS member_coupons_member ON member_coupons (member_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS member_coupons_tenant_status ON member_coupons (tenant_id, status);
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

-- 0225_vip_membership — docs/29 Phase V4 (control LYL-21): paid VIP membership. A club fee is collected
-- like a sale (Dr 1000 / Cr 2410 Contract Liability — TFRS 15 deferred revenue), recognized monthly to
-- 4300 over the period, grants the plan's tier (loyalty_tier_history reason 'vip'), and a lapsed
-- membership auto-expires on the maintenance sweep so the tier falls back to the earned ladder — no
-- perpetual free VIP. One ACTIVE membership per member (partial unique). RLS + tenant-leading indexes.
CREATE TABLE IF NOT EXISTS membership_plans (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  tier text NOT NULL,
  price numeric(14,2) NOT NULL,
  period_months integer NOT NULL DEFAULT 12,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS membership_plans_tenant_code ON membership_plans (tenant_id, code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS membership_plans_tenant ON membership_plans (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS member_memberships (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  member_id bigint NOT NULL REFERENCES pos_members(id),
  plan_id bigint NOT NULL REFERENCES membership_plans(id),
  status text NOT NULL DEFAULT 'Active',
  start_date date NOT NULL,
  end_date date NOT NULL,
  price numeric(14,2) NOT NULL,
  period_months integer NOT NULL,
  recognized_months integer NOT NULL DEFAULT 0,
  sale_ref text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS member_memberships_one_active ON member_memberships (member_id) WHERE status = 'Active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS member_memberships_tenant ON member_memberships (tenant_id, status);
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

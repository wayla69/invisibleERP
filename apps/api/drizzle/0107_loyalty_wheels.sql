-- 0107 — CRM Phase 4: spin-the-wheel / lucky draw. Weighted prize segments; each spin is an audited,
-- provably-fair outcome. New tenant_id tables → re-run the RLS loop.
CREATE TABLE IF NOT EXISTS loyalty_wheels (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  wheel_code text NOT NULL,
  name text NOT NULL,
  cost_points integer NOT NULL DEFAULT 0,
  daily_free_spins integer NOT NULL DEFAULT 0,
  active boolean DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_wheels_tenant_code ON loyalty_wheels (tenant_id, wheel_code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS loyalty_wheel_segments (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  wheel_id bigint REFERENCES loyalty_wheels(id),
  label text NOT NULL,
  prize_kind text NOT NULL DEFAULT 'none',
  prize_points integer DEFAULT 0,
  coupon_kind text,
  coupon_value numeric(14,2) DEFAULT 0,
  weight integer NOT NULL DEFAULT 1,
  stock integer,
  won_count integer NOT NULL DEFAULT 0,
  sort integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_wheel_segments_wheel ON loyalty_wheel_segments (wheel_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS loyalty_spins (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  wheel_id bigint REFERENCES loyalty_wheels(id),
  member_id bigint REFERENCES pos_members(id),
  segment_id bigint REFERENCES loyalty_wheel_segments(id),
  spin_code text NOT NULL,
  prize_kind text NOT NULL,
  prize_points integer DEFAULT 0,
  cost_points integer DEFAULT 0,
  free boolean DEFAULT false,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_spins_member ON loyalty_spins (member_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS loyalty_spins_tenant ON loyalty_spins (tenant_id, created_at);
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

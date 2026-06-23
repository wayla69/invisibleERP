-- 0069 — Buffet self-ordering (Phase 2): per-pax buffet tiers with a dining time window.
-- A table session runs in ONE mode (a_la_carte | buffet). Buffet food posts at ฿0 (is_buffet flag) but
-- still routes to the KDS; a per-pax buffet charge + an optional overtime surcharge are billed as
-- non-kitchen lines (kds_status 'served', so they never appear on the kitchen feed).

DO $$ BEGIN CREATE TYPE order_mode AS ENUM ('a_la_carte','buffet'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS buffet_packages (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  name_en text,
  price_per_pax numeric(14,2) NOT NULL,
  time_limit_min integer NOT NULL DEFAULT 90,
  overtime_fee_per_pax numeric(14,2) NOT NULL DEFAULT '0',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS buffet_packages_tenant_code_uq ON buffet_packages (tenant_id, code);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS buffet_package_items (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  package_id bigint NOT NULL REFERENCES buffet_packages(id),
  menu_item_id bigint NOT NULL REFERENCES menu_items(id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS buffet_package_items_uq ON buffet_package_items (package_id, menu_item_id);
--> statement-breakpoint

ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS order_mode order_mode NOT NULL DEFAULT 'a_la_carte';
--> statement-breakpoint
ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS buffet_package_id bigint REFERENCES buffet_packages(id);
--> statement-breakpoint
ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS pax integer;
--> statement-breakpoint
ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS buffet_started_at timestamptz;
--> statement-breakpoint
ALTER TABLE table_sessions ADD COLUMN IF NOT EXISTS buffet_expires_at timestamptz;
--> statement-breakpoint

ALTER TABLE dine_in_order_items ADD COLUMN IF NOT EXISTS is_buffet boolean NOT NULL DEFAULT false;
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

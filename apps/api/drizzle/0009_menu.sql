-- POS Tier 1 — Menu / Catalog master: categories, items (SKU/86/KDS routing),
-- priced modifier groups + options, and the item<->group link. RLS via the 0002 DO-block tail.
DO $$ BEGIN CREATE TYPE menu_item_type AS ENUM ('food','drink','retail','combo'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE menu_tax_type AS ENUM ('standard','exempt','zero'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS menu_categories (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL, name text NOT NULL, name_en text, color text,
  sort integer DEFAULT 0, active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_menu_cat UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS menu_items (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  sku text NOT NULL, name text NOT NULL, name_en text,
  category_id bigint REFERENCES menu_categories(id),
  type menu_item_type NOT NULL DEFAULT 'food',
  price numeric(14,2) NOT NULL,
  cost numeric(14,2),
  station_code text DEFAULT 'main',
  prep_minutes integer DEFAULT 10,
  tax_type menu_tax_type NOT NULL DEFAULT 'standard',
  track_stock boolean NOT NULL DEFAULT false,
  is_available boolean NOT NULL DEFAULT true,
  image_url text, description text,
  sort integer DEFAULT 0, active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT uq_menu_sku UNIQUE (tenant_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_menu_item_cat ON menu_items(category_id);

CREATE TABLE IF NOT EXISTS modifier_groups (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL, name text NOT NULL,
  min_select integer NOT NULL DEFAULT 0,
  max_select integer NOT NULL DEFAULT 1,
  required boolean NOT NULL DEFAULT false,
  sort integer DEFAULT 0, active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_mod_group UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS modifier_options (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  group_id bigint NOT NULL REFERENCES modifier_groups(id),
  name text NOT NULL,
  price_delta numeric(14,2) NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  sort integer DEFAULT 0, active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS menu_item_modifier_groups (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  menu_item_id bigint NOT NULL REFERENCES menu_items(id),
  group_id bigint NOT NULL REFERENCES modifier_groups(id),
  sort integer DEFAULT 0,
  CONSTRAINT uq_item_group UNIQUE (menu_item_id, group_id)
);

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

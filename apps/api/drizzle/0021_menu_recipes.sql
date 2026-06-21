-- POS Tier 2 #6 — Recipe / BOM ingredient deduction (ตัดวัตถุดิบตามสูตร).
CREATE TABLE IF NOT EXISTS menu_recipes (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  menu_item_id bigint NOT NULL REFERENCES menu_items(id),
  sku text NOT NULL,
  yield_qty numeric NOT NULL DEFAULT 1,
  post_cogs boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  notes text, created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT uq_recipe_menu_item UNIQUE (menu_item_id)
);
CREATE INDEX IF NOT EXISTS idx_recipe_sku ON menu_recipes (tenant_id, sku);

CREATE TABLE IF NOT EXISTS menu_recipe_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  recipe_id bigint NOT NULL REFERENCES menu_recipes(id),
  ingredient_item_id text NOT NULL,
  ingredient_description text,
  qty_per numeric NOT NULL,
  uom text,
  unit_cost numeric(14,4)
);
CREATE INDEX IF NOT EXISTS idx_recipe_line_recipe ON menu_recipe_lines (recipe_id);

-- Re-run the 0002 RLS loop so menu_recipes + menu_recipe_lines (tenant_id) are isolation-scoped.
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

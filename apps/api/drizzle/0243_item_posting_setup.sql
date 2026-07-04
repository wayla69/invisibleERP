-- 0243_item_posting_setup — Item-posting setup foundation (docs/33, GL-115). Adds a tenant-configurable
-- account/tax profile so item posting can be DERIVED (item → category → warehouse → global posting-rule
-- default) instead of hardcoded. PR1 = schema only; PostingService wiring is PR2. All item columns are
-- nullable and both new tables start empty, so an unconfigured tenant behaves exactly as today.

-- Item / product category master (tenant-scoped) — carries a default account-set + tax profile per family.
CREATE TABLE IF NOT EXISTS item_categories (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  code text NOT NULL,
  name text,
  name_th text,
  revenue_account text,
  cogs_account text,
  inventory_account text,
  valuation_account text,
  vat_code text,
  wht_income_type text,
  default_location_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_categories_code ON item_categories (tenant_id, code);
--> statement-breakpoint

-- Tax-code master (VAT + WHT) — configurable tax surface replacing the lone tenants.vat_rate column.
CREATE TABLE IF NOT EXISTS tax_codes (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  code text NOT NULL,
  name text,
  name_th text,
  kind text NOT NULL DEFAULT 'vat',           -- 'vat' | 'wht'
  rate numeric(6,4) NOT NULL DEFAULT 0,        -- 0.0700 = 7%
  output_account text,
  input_account text,
  wht_account text,
  wht_income_type text,
  inclusive boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_codes_code ON tax_codes (tenant_id, code);
--> statement-breakpoint

-- Item-level global-default account/tax profile columns (items is a global master, no tenant_id).
ALTER TABLE items ADD COLUMN IF NOT EXISTS category_id bigint;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS revenue_account text;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS cogs_account text;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS inventory_account text;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS valuation_account text;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS vat_code text;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS wht_income_type text;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS default_location_id text;
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the two new
-- tenant-scoped tables (item_categories, tax_codes) are covered. Idempotent. items has no tenant_id so the
-- loop (WHERE column_name='tenant_id') correctly leaves it unscoped/global.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))',
      r.table_name);
  END LOOP;
END $$;

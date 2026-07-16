-- 0408_cpq_pricebooks — CRM-15 CPQ pricebooks (control CRM-15).
-- A governed, effective-dated price list a quote can be priced FROM instead of ad-hoc typed unit prices.
-- cpq_pricebooks is master data (created under the `masterdata` duty like configs/rules/bundles); when a quote
-- is created against a pricebook, each line's unit price resolves from the pricebook's entry for that item
-- (by config/item code), so revenue is quoted from an approved, in-window price list. The effective window
-- (from/to) + active flag are enforced at quote time, and the CPQ-01 margin floor still governs the result.
-- quotes.pricebook_id records the pricing basis (audit). Two tenant tables (0232 RLS, tenant-leading indexes)
-- + one nullable column on quotes.

CREATE TABLE IF NOT EXISTS cpq_pricebooks (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  currency text NOT NULL DEFAULT 'THB',
  effective_from date,                            -- inclusive; null = no lower bound
  effective_to date,                              -- inclusive; null = no upper bound
  is_active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_cpq_pricebook_code ON cpq_pricebooks (tenant_id, code);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS cpq_pricebook_entries (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  pricebook_id bigint NOT NULL REFERENCES cpq_pricebooks(id),
  item_code text NOT NULL,                         -- matches product_configs.code / quote_lines.item_code
  unit_price numeric(18,4) NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_cpq_pricebook_entry ON cpq_pricebook_entries (tenant_id, pricebook_id, item_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cpq_pricebook_entry_book ON cpq_pricebook_entries (tenant_id, pricebook_id);
--> statement-breakpoint

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pricebook_id bigint;
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
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

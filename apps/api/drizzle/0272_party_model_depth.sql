-- 0272_party_model_depth — master-data audit Phase 4: the customer and vendor masters each carried exactly
-- ONE address and ONE contact (single scalar columns), so a counterparty with a separate billing/shipping
-- address or more than one point of contact had no home for the extra rows. Adds entity-specific multi-
-- address/multi-contact child tables (mirrors this codebase's existing convention of one table per real
-- entity, not a generic polymorphic "party" table) plus a parent-company self-reference on each master for
-- consolidated credit/reporting (subsidiary → parent).
ALTER TABLE customer_master ADD COLUMN IF NOT EXISTS parent_customer_no text;
--> statement-breakpoint
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS parent_vendor_id bigint;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_addresses (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  customer_id bigint NOT NULL REFERENCES customer_master(id),
  address_type text NOT NULL DEFAULT 'other',
  address_line1 text,
  address_line2 text,
  sub_district text,
  district text,
  province text,
  postal_code text,
  is_primary boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer ON customer_addresses (customer_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_addresses_tenant ON customer_addresses (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_contacts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  customer_id bigint NOT NULL REFERENCES customer_master(id),
  name text NOT NULL,
  title text,
  phone text,
  email text,
  notes text,
  is_primary boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer ON customer_contacts (customer_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_contacts_tenant ON customer_contacts (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS vendor_addresses (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  vendor_id bigint NOT NULL REFERENCES vendors(id),
  address_type text NOT NULL DEFAULT 'other',
  address_line1 text,
  address_line2 text,
  sub_district text,
  district text,
  province text,
  postal_code text,
  is_primary boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_vendor_addresses_vendor ON vendor_addresses (vendor_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_vendor_addresses_tenant ON vendor_addresses (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS vendor_contacts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  vendor_id bigint NOT NULL REFERENCES vendors(id),
  name text NOT NULL,
  title text,
  phone text,
  email text,
  notes text,
  is_primary boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_vendor_contacts_vendor ON vendor_contacts (vendor_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_vendor_contacts_tenant ON vendor_contacts (tenant_id);
--> statement-breakpoint
-- Re-run the RLS loop so the four new tenant_id tables are isolation-scoped. GRANT/ENABLE/FORCE structure
-- from 0137, CANONICAL org-clause policy body from 0232 (a plain body here would silently drop cross-account
-- org sharing on every data table). Idempotent.
DO $$
DECLARE r record;
BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
  LOOP
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

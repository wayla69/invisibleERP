-- 0256_realestate — Real-estate developer vertical, Track D / P4 (docs/35, RE-01/02/03). A DEVELOPER sells
-- units (condos/houses/land) to buyers: a development holds units (re_units, an availability/price grid); a
-- buyer BOOKS a unit with a reservation deposit (re_bookings → unit reserved); the booking becomes a sale
-- CONTRACT (re_contracts — price/discount/down-payment, maker-checker on the price/discount authority → RE-02)
-- with an INSTALLMENT plan (re_installments). Cash received before ownership transfer is a contract liability
-- (2410) / customer deposit (2210) — revenue is recognised at transfer (P5). Permission-gated (re_sales) so a
-- non-property tenant never sees it. Tenant-scoped (RLS + tenant-leading index).
CREATE TABLE IF NOT EXISTS re_projects (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  dev_code text NOT NULL,                          -- business key (development code)
  name text NOT NULL,
  location text,
  status text NOT NULL DEFAULT 'active',           -- active | closed
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_redev_tenant ON re_projects (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_redev_code ON re_projects (dev_code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS re_units (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  re_project_id bigint NOT NULL,
  unit_no text NOT NULL,                            -- unique within the development
  unit_type text NOT NULL DEFAULT 'condo',         -- condo | house | land | other
  area_sqm numeric(12,2) NOT NULL DEFAULT 0,
  floor text,
  list_price numeric(16,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'available',         -- available | reserved | contracted | transferred
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_reunit_dev ON re_units (re_project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_reunit_tenant ON re_units (tenant_id, re_project_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_reunit_no ON re_units (re_project_id, unit_no);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS re_bookings (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  unit_id bigint NOT NULL,
  booking_no text NOT NULL,                         -- business key (BKG-YYYYMMDD-NNN)
  buyer_name text,
  deposit numeric(16,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'held',              -- held | converted | cancelled
  expires_on date,
  entry_no text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rebooking_unit ON re_bookings (unit_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rebooking_tenant ON re_bookings (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_rebooking_no ON re_bookings (booking_no);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS re_contracts (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  unit_id bigint NOT NULL,
  booking_id bigint,
  contract_no text NOT NULL,                        -- business key (REC-YYYYMMDD-NNN)
  buyer_name text,
  list_price numeric(16,2) NOT NULL DEFAULT 0,
  discount numeric(16,2) NOT NULL DEFAULT 0,
  price numeric(16,2) NOT NULL DEFAULT 0,           -- list_price − discount
  down_payment numeric(16,2) NOT NULL DEFAULT 0,
  balance numeric(16,2) NOT NULL DEFAULT 0,         -- price − down_payment (installment total)
  installment_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',             -- draft | active | transferred | cancelled
  entry_no text,
  created_by text,
  approved_by text,                                 -- checker — must differ from created_by (SoD, RE-02)
  approved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_recontract_unit ON re_contracts (unit_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_recontract_tenant ON re_contracts (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_recontract_no ON re_contracts (contract_no);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS re_installments (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  contract_id bigint NOT NULL,
  seq integer NOT NULL DEFAULT 1,
  due_date date,
  amount numeric(16,2) NOT NULL DEFAULT 0,
  paid_amount numeric(16,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',           -- pending | paid
  paid_at timestamptz,
  entry_no text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_reinstall_contract ON re_installments (contract_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_reinstall_tenant ON re_installments (tenant_id, status, due_date);
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

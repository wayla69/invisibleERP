-- 0275_party_relationships — master-data audit Phase 8 (Oracle-TCA-style typed party relationships).
-- Phase 4 gave each master a single parent-company pointer. Real party models carry ARBITRARY typed
-- relationships between two parties — bill-to / ship-to / sold-to (a different legal entity is billed or
-- shipped), guarantor (a party guarantees another's credit), related-party (SOX related-party disclosure),
-- subsidiary/franchisee. This adds a generic directional relationship table per master (from → to, typed),
-- generalising the parent pointer (which stays for the consolidated-credit rollup). Change-audited (0274
-- trigger) + RLS + tenant-leading index like every tenant table.
CREATE TABLE IF NOT EXISTS customer_relationships (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  from_customer_id bigint NOT NULL REFERENCES customer_master(id),
  to_customer_id bigint NOT NULL REFERENCES customer_master(id),
  rel_type text NOT NULL DEFAULT 'related_party',
  note text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_relationships_tenant ON customer_relationships (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_relationships_from ON customer_relationships (from_customer_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_relationships ON customer_relationships (from_customer_id, to_customer_id, rel_type);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS vendor_relationships (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  from_vendor_id bigint NOT NULL REFERENCES vendors(id),
  to_vendor_id bigint NOT NULL REFERENCES vendors(id),
  rel_type text NOT NULL DEFAULT 'related_party',
  note text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_vendor_relationships_tenant ON vendor_relationships (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_vendor_relationships_from ON vendor_relationships (from_vendor_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_relationships ON vendor_relationships (from_vendor_id, to_vendor_id, rel_type);
--> statement-breakpoint
-- Change-history trigger (0274 / ITGC-AC-14) on the new relationship tables.
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['customer_relationships','vendor_relationships'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_dcl_%I ON public.%I', r, r);
    EXECUTE format('CREATE TRIGGER trg_dcl_%I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION log_data_change()', r, r);
  END LOOP;
END $$;
--> statement-breakpoint
-- Re-run the RLS loop so the two new tenant_id tables are isolation-scoped. GRANT/ENABLE/FORCE from 0137,
-- CANONICAL org-clause policy body from 0232 (a plain body would silently drop cross-account org sharing).
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

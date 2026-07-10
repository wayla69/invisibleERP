-- 0311_arap_netting — AR/AP netting & contra settlement (docs/41 FIN-8, control REV-23). A counterparty that
-- is BOTH a customer (AR) and a vendor (AP) can have its open AR offset against its open AP with a single
-- contra JE (Dr 2000 AP / Cr 1100 AR) that clears both sub-ledgers up to the netted amount, leaving the
-- residual open. Three tenant-scoped tables (RLS + tenant-leading indexes): (1) netting_agreements — the
-- counterparty mapping + netting_enabled/threshold; (2) netting_settlements — the maker-checker workflow
-- header + netting-statement head (PendingApproval → Approved by a DIFFERENT user; the contra JE posts only
-- at approval); (3) netting_settlement_lines — the offset detail (which AR invoices + AP bills, by how much).
-- customer_tenant_id / vendor_id / agreement_id / settlement_id are FK columns (NOT the RLS tenant_id) so the
-- generic RLS loop skips them.
CREATE TABLE IF NOT EXISTS netting_agreements (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  customer_tenant_id bigint NOT NULL REFERENCES tenants(id),
  vendor_id bigint NOT NULL REFERENCES vendors(id),
  vendor_name text,
  counterparty_name text,
  currency text DEFAULT 'THB',
  netting_enabled boolean NOT NULL DEFAULT true,
  threshold numeric(14,2),
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ux_netting_agreement ON netting_agreements (coalesce(tenant_id, 0), customer_tenant_id, vendor_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_netting_agreement_customer ON netting_agreements (tenant_id, customer_tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_netting_agreement_vendor ON netting_agreements (tenant_id, vendor_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS netting_settlements (
  id bigserial PRIMARY KEY,
  settlement_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  agreement_id bigint REFERENCES netting_agreements(id),
  customer_tenant_id bigint,
  vendor_id bigint,
  vendor_name text,
  counterparty_name text,
  currency text DEFAULT 'THB',
  ar_open numeric(14,2),
  ap_open numeric(14,2),
  net_amount numeric(14,2) NOT NULL,
  threshold numeric(14,2),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PendingApproval',
  proposed_by text,
  proposed_at timestamptz DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  reject_reason text,
  je_entry_no text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_netting_settlement_status ON netting_settlements (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS netting_settlement_lines (
  id bigserial PRIMARY KEY,
  settlement_id bigint NOT NULL,
  tenant_id bigint REFERENCES tenants(id),
  side text NOT NULL,
  doc_no text NOT NULL,
  doc_open numeric(14,2),
  applied_amount numeric(14,2) NOT NULL,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_netting_line_settlement ON netting_settlement_lines (tenant_id, settlement_id);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new
-- tenant_id tables get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

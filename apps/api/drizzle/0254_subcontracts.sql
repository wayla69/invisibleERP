-- 0254_subcontracts — Construction/real-estate vertical Track B (docs/35 P2, PROJ-17). Subcontractor
-- management: a subcontract is a priced scope against BoQ lines executed by a subcontractor. It REGISTERS a
-- commitment on its BoQ lines (via the docs/32 commitment ledger, source SUBCON) so it counts against the
-- works budget exactly like a PO. The subcontractor submits periodic VALUATIONS we certify (maker-checker →
-- PROJ-17): each certifies the % complete of the subcontract, withholds RETENTION PAYABLE (เงินประกันผลงาน
-- ค้างจ่าย, into the shared sub-ledger, migration 0252), deducts BACK-CHARGES, and posts the certified NET to
-- AP with the project dimension. Tenant-scoped (RLS + tenant-leading index).
CREATE TABLE IF NOT EXISTS project_subcontracts (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  project_id bigint NOT NULL,
  subcontract_no text NOT NULL,                    -- business key (SC-YYYYMMDD-NNN)
  vendor_name text,                                -- the subcontractor
  title text,
  contract_value numeric(16,2) NOT NULL DEFAULT 0, -- Σ scope amounts
  retention_pct numeric(9,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',           -- active | closed
  certified_to_date numeric(16,2) NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subcon_project ON project_subcontracts (tenant_id, project_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_subcon_no ON project_subcontracts (subcontract_no);
--> statement-breakpoint
-- The subcontracted portion of each BoQ line (drives the commitment reserved against that line's budget).
CREATE TABLE IF NOT EXISTS subcontract_scope (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  subcontract_id bigint NOT NULL,
  boq_line_id bigint NOT NULL,
  description text,
  amount numeric(16,2) NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subcon_scope_sub ON subcontract_scope (subcontract_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subcon_scope_boq ON subcontract_scope (tenant_id, boq_line_id);
--> statement-breakpoint
-- A periodic subcontractor progress valuation (งวดผู้รับเหมาช่วง). value_to_date = contract_value × pct/100;
-- gross_this_val = value_to_date − previously certified; net_certified = gross − retention − back_charge.
CREATE TABLE IF NOT EXISTS subcontract_valuations (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  subcontract_id bigint NOT NULL,
  valuation_no text NOT NULL,                      -- business key (SV-YYYYMMDD-NNN)
  seq integer NOT NULL DEFAULT 1,
  period text,
  status text NOT NULL DEFAULT 'draft',            -- draft | certified
  pct_complete numeric(9,4) NOT NULL DEFAULT 0,    -- 0..100 of the subcontract value
  value_to_date numeric(16,2) NOT NULL DEFAULT 0,
  prev_certified numeric(16,2) NOT NULL DEFAULT 0,
  gross_this_val numeric(16,2) NOT NULL DEFAULT 0,
  retention_pct numeric(9,4) NOT NULL DEFAULT 0,
  retention_amount numeric(16,2) NOT NULL DEFAULT 0,
  back_charge numeric(16,2) NOT NULL DEFAULT 0,
  net_certified numeric(16,2) NOT NULL DEFAULT 0,
  entry_no text,
  created_by text,
  certified_by text,                               -- checker — must differ from created_by (SoD, PROJ-17)
  certified_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subval_sub ON subcontract_valuations (subcontract_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_subval_tenant ON subcontract_valuations (tenant_id, subcontract_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_subval_no ON subcontract_valuations (valuation_no);
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

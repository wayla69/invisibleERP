-- 0087 — Document templates (Platform Phase 10 — A3). A per-tenant, no-code registry that customizes the
-- PRESENTATION of customer-facing documents (receipt first; tax invoices / quotations / POs / payslips
-- follow). `config` is a presentation-only JSON blob (header/body/footer/paper knobs); it never controls
-- amounts, never omits a legally-mandatory field, and posts nothing to the GL. One row per (tenant, doc_type)
-- is flagged is_default = the active template consumed at render time. New tenant_id table → RLS loop re-run.

CREATE TABLE IF NOT EXISTS document_templates (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  doc_type text NOT NULL,                     -- receipt | tax_invoice_abbreviated | tax_invoice_full | quotation | purchase_order | payslip
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,  -- presentation-only knobs (header/body/footer/paper)
  is_default boolean NOT NULL DEFAULT false,  -- the active template for this (tenant, doc_type)
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
-- one template name per tenant + doc_type
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_templates_name ON document_templates (tenant_id, doc_type, name);
--> statement-breakpoint
-- fast "active default for this doc_type" lookup at render time
CREATE INDEX IF NOT EXISTS idx_document_templates_active ON document_templates (tenant_id, doc_type, is_default);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id table is isolation-scoped.
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

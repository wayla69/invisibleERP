-- Phase 10: Thai tax documents — tax invoices (ม.86/4 + 86/6) + WHT 50 ทวิ (ม.50 ทวิ).
DO $$ BEGIN CREATE TYPE tax_invoice_type AS ENUM ('full','abbreviated'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE tax_invoice_status AS ENUM ('Issued','Voided','Replaced'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE tax_doc_source AS ENUM ('POS','AR'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE pnd_type AS ENUM ('PND1K','PND1KS','PND2','PND2K','PND3','PND3K','PND53'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE wht_form_copy AS ENUM ('copy1','copy2','copy3','copy4'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE wht_cert_status AS ENUM ('Issued','Voided'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS tax_invoices (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  doc_no text NOT NULL,
  book_no text,
  type tax_invoice_type NOT NULL,
  issue_date date NOT NULL,
  source_type tax_doc_source NOT NULL,
  source_ref text NOT NULL,
  seller_name text NOT NULL,
  seller_tax_id text NOT NULL,
  seller_branch_code text NOT NULL DEFAULT '00000',
  seller_branch_label text NOT NULL DEFAULT 'สำนักงานใหญ่',
  seller_address text NOT NULL,
  buyer_name text,
  buyer_tax_id text,
  buyer_branch_code text,
  buyer_address text,
  currency text NOT NULL DEFAULT 'THB',
  subtotal numeric(14,2) NOT NULL,
  discount numeric(14,2) DEFAULT '0',
  vat_rate numeric(5,4) NOT NULL DEFAULT '0.0700',
  vat_amount numeric(14,2) NOT NULL,
  grand_total numeric(14,2) NOT NULL,
  is_vat_inclusive boolean NOT NULL DEFAULT false,
  status tax_invoice_status NOT NULL DEFAULT 'Issued',
  replaces_doc_no text,
  void_reason text,
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_tiv_doc UNIQUE (tenant_id, doc_no)
);

CREATE TABLE IF NOT EXISTS tax_invoice_lines (
  id bigserial PRIMARY KEY,
  tax_invoice_id bigint NOT NULL REFERENCES tax_invoices(id),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  line_no numeric NOT NULL,
  item_id text,
  description text NOT NULL,
  qty numeric(14,3),
  uom text,
  unit_price numeric(14,2),
  discount numeric(14,2) DEFAULT '0',
  amount numeric(14,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS wht_certificates (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  doc_no text NOT NULL,
  book_no text,
  run_no text,
  pnd_type pnd_type NOT NULL,
  form_copy wht_form_copy NOT NULL DEFAULT 'copy1',
  date_paid date NOT NULL,
  payer_name text NOT NULL,
  payer_tax_id text NOT NULL,
  payer_branch_code text NOT NULL DEFAULT '00000',
  payer_address text NOT NULL,
  payee_name text NOT NULL,
  payee_tax_id text NOT NULL,
  payee_branch_code text,
  payee_address text,
  payee_kind text NOT NULL DEFAULT 'company',
  ap_txn_no text,
  payment_no text,
  total_paid numeric(14,2) NOT NULL,
  total_wht numeric(14,2) NOT NULL,
  wht_condition text NOT NULL DEFAULT 'withhold',
  wht_condition_other text,
  signer_name text,
  is_replacement boolean NOT NULL DEFAULT false,
  status wht_cert_status NOT NULL DEFAULT 'Issued',
  created_by text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_wht_doc UNIQUE (tenant_id, doc_no)
);

CREATE TABLE IF NOT EXISTS wht_cert_lines (
  id bigserial PRIMARY KEY,
  wht_cert_id bigint NOT NULL REFERENCES wht_certificates(id),
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  income_type text NOT NULL,
  description text,
  date_paid date,
  amount_paid numeric(14,2) NOT NULL,
  rate numeric(5,4) NOT NULL,
  tax_withheld numeric(14,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS doc_counters_tenant (
  doc_type text NOT NULL,
  tenant_id bigint NOT NULL,
  period text NOT NULL,
  n integer NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_type, tenant_id, period)
);

CREATE INDEX IF NOT EXISTS idx_tiv_source ON tax_invoices(source_type, source_ref);
CREATE INDEX IF NOT EXISTS idx_tiv_tenant_date ON tax_invoices(tenant_id, issue_date);
CREATE INDEX IF NOT EXISTS idx_wht_tenant_date ON wht_certificates(tenant_id, date_paid);
CREATE INDEX IF NOT EXISTS idx_wht_ap ON wht_certificates(ap_txn_no);

-- Re-run the 0002 RLS loop so the new tenant_id tables get tenant_isolation + grants.
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
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint)'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint)',
      r.table_name);
  END LOOP;
END $$;

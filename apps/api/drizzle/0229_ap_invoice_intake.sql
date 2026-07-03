-- 0229_ap_invoice_intake — scanned-invoice intake → PO auto-map → automated 3-way match (EXP-10).
-- A scanned/pasted vendor invoice is extracted (doc-ai), auto-mapped to an approved PO (explicit PO number
-- in the document, else vendor + amount scoring), then posted as an AP bill and 3-way matched in one flow.
-- Unmappable documents queue as NeedsReview; payment itself stays behind the AP-PAY maker-checker (EXP-06)
-- and the EXP-01 match gate — this table automates the path TO payment-ready, never the disbursement.
CREATE TABLE IF NOT EXISTS ap_invoice_intakes (
  id bigserial PRIMARY KEY,
  intake_no text NOT NULL UNIQUE,
  tenant_id bigint REFERENCES tenants(id),
  raw_text text,
  vendor_id bigint REFERENCES vendors(id),
  vendor_name text,
  vendor_tax_id text,
  invoice_no text,
  invoice_date date,
  amount numeric(14,2),
  currency text DEFAULT 'THB',
  extract_source text,
  po_no text,
  map_method text,
  map_confidence numeric(5,2),
  candidates jsonb,
  dup_of text,
  file_name text,
  file_mime text,
  file_ref text,
  status text NOT NULL DEFAULT 'NeedsReview',
  txn_no text,
  match_status text,
  payable boolean,
  created_by text,
  created_at timestamptz DEFAULT now(),
  posted_by text,
  posted_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_intake_status ON ap_invoice_intakes (tenant_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_intake_txn ON ap_invoice_intakes (txn_no);
--> statement-breakpoint
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

-- Phase 16 — Source-to-Pay: 3-way match + RFQ/sourcing + supplier screening. No NEW GL — 3-way match
-- GATES the existing AP pay (Dr 2000 / Cr 1000). RLS via the 0002 DO-block re-run at tail.

-- supplier screening on the existing vendors master
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved';
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS blocklisted boolean NOT NULL DEFAULT false;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS blocklist_reason text;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS scorecard_score numeric(5,2);

CREATE TABLE IF NOT EXISTS supplier_scorecards (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  vendor_id bigint REFERENCES vendors(id),
  period text,
  on_time_pct numeric(5,2), quality_pct numeric(5,2), price_var_pct numeric(5,2),
  score numeric(5,2),
  gr_count integer DEFAULT 0, claim_count integer DEFAULT 0,
  created_at timestamptz DEFAULT now(), created_by text,
  CONSTRAINT supplier_scorecards_uq UNIQUE (vendor_id, period)
);

CREATE TABLE IF NOT EXISTS rfqs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  rfq_no text NOT NULL UNIQUE,
  rfq_date date, status text NOT NULL DEFAULT 'Open',
  required_date date, remarks text, created_by text, awarded_quote_id bigint,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rfq_items (
  id bigserial PRIMARY KEY,
  rfq_id bigint NOT NULL REFERENCES rfqs(id),
  item_id text, item_description text, qty numeric, uom text
);
CREATE TABLE IF NOT EXISTS supplier_quotes (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  quote_no text NOT NULL UNIQUE,
  rfq_id bigint NOT NULL REFERENCES rfqs(id),
  vendor_id bigint REFERENCES vendors(id), vendor_name text,
  quote_date date, valid_until date, lead_time_days integer,
  total_amount numeric(14,2), status text NOT NULL DEFAULT 'Submitted',
  created_by text, created_at timestamptz DEFAULT now()
);
CREATE TABLE IF NOT EXISTS supplier_quote_items (
  id bigserial PRIMARY KEY,
  quote_id bigint NOT NULL REFERENCES supplier_quotes(id),
  item_id text, item_description text, qty numeric, unit_price numeric(14,2), uom text
);

CREATE TABLE IF NOT EXISTS match_tolerance (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  qty_pct numeric(6,3) NOT NULL DEFAULT 0,
  price_pct numeric(6,3) NOT NULL DEFAULT 2,
  amount_pct numeric(6,3) NOT NULL DEFAULT 2,
  amount_abs numeric(14,2) NOT NULL DEFAULT 0.50,
  updated_by text, updated_at timestamptz DEFAULT now(),
  CONSTRAINT match_tolerance_tenant_uq UNIQUE (tenant_id)
);

CREATE TABLE IF NOT EXISTS invoice_match_results (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  match_no text NOT NULL UNIQUE,
  txn_no text NOT NULL,
  po_no text,
  match_status text NOT NULL,
  payable boolean NOT NULL DEFAULT false,
  override boolean NOT NULL DEFAULT false,
  override_by text, override_reason text, override_at timestamptz,
  matched_by text, matched_at timestamptz DEFAULT now(),
  CONSTRAINT invoice_match_results_txn_uq UNIQUE (txn_no)
);
CREATE TABLE IF NOT EXISTS invoice_match_lines (
  id bigserial PRIMARY KEY,
  match_id bigint NOT NULL REFERENCES invoice_match_results(id) ON DELETE CASCADE,
  item_id text,
  inv_qty numeric, inv_price numeric(14,2),
  po_qty numeric, po_price numeric(14,2),
  gr_qty numeric,
  qty_var_pct numeric(8,3), price_var_pct numeric(8,3),
  line_status text NOT NULL
);

-- Re-run the 0002 RLS loop so the new tenant_id tables get tenant_isolation.
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

-- 0137 — Procure-to-Capitalize: register a fixed asset from a Goods Receipt (FA-10). A purchase line can be
-- flagged "capital" (on the item master, or per-PO-line override). When such a line is received, the GR line
-- carries is_capital=true and becomes ELIGIBLE for capitalization — but creating the asset is a maker-checker
-- REQUEST: a preparer raises an asset_registration_request (posts NOTHING to the GL), and a DIFFERENT user
-- approves it. Only on approval is the fixed_assets row created and the GL posted (Dr 1500 / Cr 2000). This is
-- the authorization control over what enters the asset register and at what cost — one person can no longer
-- both receive goods and capitalize them onto the books. fixed_assets gains source_gr_no/source_po_no for
-- end-to-end traceability (PR → PO → GR → FA).

-- Item master: which items are capital goods, and their default asset category.
ALTER TABLE items ADD COLUMN IF NOT EXISTS is_fixed_asset boolean NOT NULL DEFAULT false;
ALTER TABLE items ADD COLUMN IF NOT EXISTS default_asset_category_id bigint;

-- PO line: per-order override (a normally-expensed item bought as capital this once, or vice-versa).
ALTER TABLE po_items ADD COLUMN IF NOT EXISTS is_capital boolean NOT NULL DEFAULT false;

-- GR line: denormalised eligibility flag, set at receipt from the PO line / item master.
ALTER TABLE gr_items ADD COLUMN IF NOT EXISTS is_capital boolean NOT NULL DEFAULT false;

-- Asset register traceability back to the procurement chain.
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS source_gr_no text;
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS source_po_no text;

-- Maker-checker registration request. A row in PendingApproval has NO accounting effect; on approval the
-- fixed_assets row + acquisition JE are created and asset_no is stamped back here (and onto the GR line).
CREATE TABLE IF NOT EXISTS asset_registration_requests (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  reg_no text NOT NULL,                               -- FAR-YYYYMMDD-NNN
  gr_no text,                                          -- source goods receipt
  po_no text,                                          -- source purchase order (traceability)
  gr_item_id bigint,                                   -- the specific GR line being capitalised
  item_id text,
  name text NOT NULL,
  category_id bigint,
  acquire_date date,
  acquire_cost numeric(18,4) NOT NULL,
  salvage_value numeric(18,4) NOT NULL DEFAULT 0,
  useful_life_months integer,
  acquire_source text NOT NULL DEFAULT 'credit',       -- received on account → AP (2000)
  location text,
  department text,
  serial_no text,
  notes text,
  status text NOT NULL DEFAULT 'PendingApproval',      -- PendingApproval | Posted | Rejected
  asset_no text,                                        -- the created fixed asset, once approved
  requested_by text,
  requested_at timestamptz DEFAULT now(),
  approved_by text,                                     -- checker — must differ from requested_by
  approved_at timestamptz,
  reject_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_asset_reg_no ON asset_registration_requests (tenant_id, reg_no);
CREATE INDEX IF NOT EXISTS idx_asset_reg_status ON asset_registration_requests (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_asset_reg_gr ON asset_registration_requests (gr_no);
CREATE INDEX IF NOT EXISTS idx_asset_reg_gritem ON asset_registration_requests (gr_item_id);

-- Re-run the RLS loop so the new tenant_id table is isolation-scoped (idempotent — DROP POLICY IF EXISTS).
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

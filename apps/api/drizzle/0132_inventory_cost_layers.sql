-- 0132 — FIFO/FEFO cost layers for the perpetual inventory sub-ledger (Tier 1 lots/costing).
-- Adds an opt-in costing method per item (moving_avg DEFAULT | fifo | fefo). For fifo/fefo items each
-- valued receipt creates a cost LAYER (with optional lot/expiry); issues + shrinkage consume layers in
-- order (FEFO = soonest-expiry-first, FIFO = oldest-receipt-first) → COGS at ACTUAL layer cost; transfers
-- move the consumed layer slices to the destination. inv_balances.total_value stays = Σ remaining layer
-- value, so valuation + INV-06 reconciliation are unchanged. Moving-average items are entirely unaffected.

ALTER TABLE inv_balances ADD COLUMN IF NOT EXISTS costing_method text NOT NULL DEFAULT 'moving_avg';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS inv_cost_layers (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  item_id text NOT NULL,
  location_id text NOT NULL DEFAULT 'WH-MAIN',
  lot_no text,
  expiry_date date,
  received_at timestamptz DEFAULT now(),
  orig_qty numeric(18,4) NOT NULL,
  remaining_qty numeric(18,4) NOT NULL,
  unit_cost numeric(18,4) NOT NULL DEFAULT 0,
  ref_type text,
  ref_id text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_layers_consume ON inv_cost_layers (tenant_id, item_id, location_id, remaining_qty);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_layers_fefo ON inv_cost_layers (tenant_id, item_id, location_id, expiry_date);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id table (inv_cost_layers) is isolation-scoped.
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

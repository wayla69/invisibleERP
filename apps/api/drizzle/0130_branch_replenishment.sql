-- 0130 — branch-aware replenishment (transfer-before-buy). New tenant_id tables: branch_stock (per-branch
-- on-hand ledger that runs ALONGSIDE customer_inventory) + item_supplier (preferred vendor per item for the
-- "buy" leg). Extends replenishment_suggestions with the transfer/buy routing columns. New tenant_id tables
-- → RLS loop re-run (auto-enrols any table with a tenant_id column into tenant_isolation).
CREATE TABLE IF NOT EXISTS branch_stock (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  branch_id bigint,
  item_id text,
  item_description text,
  uom text,
  on_hand numeric DEFAULT 0,
  reorder_point numeric DEFAULT 0,
  reorder_qty numeric DEFAULT 0,
  last_updated timestamptz,
  CONSTRAINT branch_stock_uq UNIQUE (tenant_id, branch_id, item_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_branchstock_item ON branch_stock (tenant_id, item_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS item_supplier (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  item_id text,
  vendor_id bigint REFERENCES vendors(id),
  unit_price numeric(14,2),
  lead_time_days integer DEFAULT 3,
  preferred boolean DEFAULT false,
  CONSTRAINT item_supplier_uq UNIQUE (tenant_id, item_id, vendor_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_itemsupplier_item ON item_supplier (tenant_id, item_id);
--> statement-breakpoint
ALTER TABLE replenishment_suggestions ADD COLUMN IF NOT EXISTS branch_id bigint;
--> statement-breakpoint
ALTER TABLE replenishment_suggestions ADD COLUMN IF NOT EXISTS route text;
--> statement-breakpoint
ALTER TABLE replenishment_suggestions ADD COLUMN IF NOT EXISTS from_branch_id bigint;
--> statement-breakpoint
ALTER TABLE replenishment_suggestions ADD COLUMN IF NOT EXISTS transfer_qty numeric;
--> statement-breakpoint
ALTER TABLE replenishment_suggestions ADD COLUMN IF NOT EXISTS buy_qty numeric;
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

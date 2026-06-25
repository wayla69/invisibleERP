-- 0130 — Perpetual inventory valuation sub-ledger (INV cycle).
-- Turns inventory from a snapshot/report facade into a transactional, VALUED sub-ledger:
--   inv_moves     append-only valued movement ledger (receipt / issue / adjust). Every financial move
--                 posts a balanced JE via LedgerService (Dr/Cr 1200 Inventory ↔ 2000 AP / 5000 COGS / 5810).
--   inv_balances  running on-hand qty + moving-average cost + total value per (tenant, item, location).
-- Controls: strengthens INV-01 negative-stock guard + INV-02 perpetual completeness (idempotent posting
--           via ref unique + GL ux_je_idem) + INV-04 adjustment authority (SoD wh_adjust), and ADDS
--           INV-05 perpetual sub-ledger ↔ GL control-account reconciliation (moving-average valuation).
-- Both carry tenant_id → re-run the 0002 RLS loop so they are isolation-scoped.

CREATE TABLE IF NOT EXISTS inv_moves (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  move_no text NOT NULL,
  move_date timestamptz DEFAULT now(),
  move_type text NOT NULL,                       -- 'receipt' | 'issue' | 'adjust'
  item_id text NOT NULL,
  item_description text,
  uom text,
  location_id text DEFAULT 'WH-MAIN',
  qty numeric(18,4) NOT NULL,                    -- signed: + into stock, − out of stock
  unit_cost numeric(18,4) NOT NULL DEFAULT 0,
  total_cost numeric(18,4) NOT NULL DEFAULT 0,   -- signed value impact on inventory
  balance_qty numeric(18,4),                     -- on-hand after this move
  avg_cost numeric(18,4),                        -- moving-average after this move
  ref_type text,
  ref_id text,
  reason text,
  gl_entry_no text,                              -- JE that carried this move (audit link)
  created_by text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT inv_moves_ref_uniq UNIQUE (tenant_id, ref_type, ref_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_moves_item ON inv_moves (tenant_id, item_id, location_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_moves_no ON inv_moves (tenant_id, move_no);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS inv_balances (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  item_id text NOT NULL,
  item_description text,
  location_id text NOT NULL DEFAULT 'WH-MAIN',
  on_hand_qty numeric(18,4) NOT NULL DEFAULT 0,
  avg_cost numeric(18,4) NOT NULL DEFAULT 0,
  total_value numeric(18,4) NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT inv_balances_uniq UNIQUE (tenant_id, item_id, location_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inv_balances_item ON inv_balances (tenant_id, item_id);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id tables are isolation-scoped.
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

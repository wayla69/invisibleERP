-- 0341_transfer_orders — INV-2: inter-warehouse/branch transfer orders with in-transit ownership + GL (INV-16).
-- A TWO-STEP ship→receive transfer order, distinct from the existing instant value-neutral stock-ops transfer
-- (kept as-is). On SHIP the value leaves the source location's inventory into a Goods-in-Transit control
-- account (Dr 1255 Goods-in-Transit / Cr 1200 Inventory); on RECEIVE it lands at the destination
-- (Dr 1200 Inventory / Cr 1255 Goods-in-Transit). Between the two, ownership sits in-transit — the period-end
-- cutoff/aging report (control INV-16) evidences inventory existence at period end. Custody segregation (SoD):
-- the receiver must differ from the shipper (SOD_SELF_APPROVAL).
--   • transfer_orders       — the header (Draft|Shipped|Received|Cancelled + from/to location + ship/receive
--                             evidence: who/when + the two JE numbers).
--   • transfer_order_lines  — one row per item (qty + the ship-time cost snapshot + carried FIFO/FEFO slices).
-- GL account 1255 Goods-in-Transit is added to the seeded chart of accounts + the SCF CF_CLASSIFY map in code
-- (ledger-constants.ts); it is NOT the same as 1250 Work-in-Process (manufacturing WIP), which is untouched.
-- Both tables tenant-scoped: a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation RLS
-- policy (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS transfer_orders (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  to_no text NOT NULL,
  from_location text NOT NULL,
  to_location text NOT NULL,
  status text NOT NULL DEFAULT 'Draft',
  remarks text,
  shipped_by text,
  shipped_at timestamptz,
  received_by text,
  received_at timestamptz,
  ship_gl_entry_no text,
  receive_gl_entry_no text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS transfer_order_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  to_no text NOT NULL,
  item_id text NOT NULL,
  item_description text,
  uom text,
  qty numeric(18,4) NOT NULL DEFAULT '0',
  unit_cost numeric(18,4) NOT NULL DEFAULT '0',
  line_value numeric(18,4) NOT NULL DEFAULT '0',
  cost_slices text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_transfer_orders_no ON transfer_orders (tenant_id, to_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_transfer_orders_tenant ON transfer_orders (tenant_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_transfer_orders_no ON transfer_orders (tenant_id, to_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_transfer_order_lines_tenant ON transfer_order_lines (tenant_id, to_no);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new tables
-- get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

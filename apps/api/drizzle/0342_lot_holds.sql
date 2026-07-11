-- 0342_lot_holds — INV-5 / INV-18: lot recall / genealogy traceability + lot hold (quarantine) control.
-- The `lots` module was read-only over lot_ledger (ledger inquiry, expiry buckets, FEFO suggestion). This
-- adds a real detective + preventive traceability control for F&B / pharma:
--   • Backward trace (lot → goods receipt → supplier) and forward trace (lot → issues/picks → sales/customers)
--     are read-only aggregations over lot_ledger + goods_receipts + pick_lists/cust_pos_sales — no new table.
--   • lot_holds — a one-click QUARANTINE. A Held lot is EXCLUDED from FEFO pick-suggestion and from the WMS
--     wave bin-allocation (suggestPickBin), so a recalled/suspect lot physically cannot be picked, shipped
--     or sold. Release supersedes it (status Held → Released) and re-enables picking. The active hold for a
--     (tenant, lot_no) is the latest row; history is retained for audit/recall evidence.
-- lot_ledger itself has NO tenant_id (a shared physical ledger written by GR receipt + WMS putaway/pick), so
-- hold state cannot be a flag on it — lot_holds is a genuinely tenant-scoped table and gets the CANONICAL
-- 0232-form tenant_isolation RLS policy (org-sharing clause), a leading (tenant_id, …) index, and app_user
-- grants. Idempotent; runs on PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS lot_holds (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  hold_no text NOT NULL,
  lot_no text NOT NULL,
  item_id text,
  status text NOT NULL DEFAULT 'Held',
  reason text,
  held_by text,
  held_at timestamptz DEFAULT now(),
  released_by text,
  released_at timestamptz,
  release_reason text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lot_holds_tenant ON lot_holds (tenant_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lot_holds_lot ON lot_holds (tenant_id, lot_no);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_lot_holds_no ON lot_holds (tenant_id, hold_no);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new table
-- gets RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

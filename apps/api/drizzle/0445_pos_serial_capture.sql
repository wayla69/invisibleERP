-- 0445_pos_serial_capture — serial/IMEI capture on the POS sale line (docs/52 Phase 3b).
-- A serial-tracked item (electronics: phones/appliances/tools) is sold as a SPECIFIC physical unit — the
-- exact serial/IMEI leaves stock and is marked sold, so warranty, returns and theft-recovery can key on it.
--   • items.is_serial_tracked — the shared item master flag (tenant-neutral, no RLS loop, mirrors is_lot_tracked);
--   • cust_pos_items.serial_no — the (first) serial the sale line consumed;
--   • item_serials — the per-unit register (InStock → Sold), TENANT-SCOPED (a serialised unit belongs to one
--     shop), so it gets the CANONICAL 0232-form tenant_isolation RLS, a leading (tenant_id,…) index + grants.
ALTER TABLE items ADD COLUMN IF NOT EXISTS is_serial_tracked boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE cust_pos_items ADD COLUMN IF NOT EXISTS serial_no text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS item_serials (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  item_id text NOT NULL,
  serial_no text NOT NULL,
  status text NOT NULL DEFAULT 'InStock',   -- InStock | Sold | Returned | Void
  received_ref text,
  sale_no text,
  sold_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_item_serials_tenant ON item_serials (tenant_id, item_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_serials_no ON item_serials (tenant_id, item_id, serial_no);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
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

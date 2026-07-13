-- 0387 — Tenant-scope the legacy core P2P pipeline (purchase_requests, pr_items, purchase_orders,
-- po_items, po_deliveries, goods_receipts, gr_items).
--
-- ROOT CAUSE: these 7 tables date to 0000_big_elektra (the pre-multi-tenancy schema) and never received
-- a tenant_id column. Every table added since (rfqs, supplier_quotes, invoice_match_results,
-- ap_invoice_intakes, supplier_price_lists, my_purchase_orders, ...) is properly tenant-scoped — this
-- core P2P slice was simply missed. Net effect: every company on the platform sees the same shared
-- PR/PO/GR list, unfiltered by RLS (the generic 0002/0232 loop only covers tables that HAVE a tenant_id
-- column, so these were silently excluded — and for the same reason factoryResetTenant() never touched
-- them either, since it enumerates the same way).
--
-- Audited row counts in prod before this migration (read-only, 2026-07-13): purchase_requests=7,
-- pr_items=27, purchase_orders=18, po_items=77, po_deliveries=0, goods_receipts=13, gr_items=54. Every
-- row is attributable: purchase_orders/purchase_requests actors are either a real login (backfilled via
-- users.tenant_id) or the 'procurement-demo' seed-script tag (database/seed-demo-procurement.ts:20),
-- which hardcodes the OSHINEI tenant. Child tables inherit their parent's tenant_id via FK. No orphaned
-- rows are expected — the final verification block below fails the migration loudly if any remain NULL,
-- rather than silently leaving orphaned/invisible-to-everyone data.
--
-- NB (first deploy attempt, 2026-07-13): the original version of this file batched multiple UPDATE
-- statements per migration-runner dispatch chunk, which caused the backfill to silently no-op in prod
-- (deploy failed on step 4's fail-loud check, reporting all 196 rows unattributed) even though the
-- identical logic run as individually-dispatched queries backfills every row cleanly (verified directly
-- against prod in a rolled-back transaction). Root cause not fully isolated (suspected drizzle-kit/
-- postgres-js multi-statement-chunk dispatch), but the fix is unambiguous: one statement per dispatch
-- chunk, forcing each UPDATE to run as its own round-trip. The failed attempt rolled back cleanly (this
-- file was never marked applied), so editing it in place is safe.

-- ── 1. Add the column ───────────────────────────────────────────────────────────────────────────────
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants(id);
--> statement-breakpoint
ALTER TABLE pr_items          ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants(id);
--> statement-breakpoint
ALTER TABLE purchase_orders   ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants(id);
--> statement-breakpoint
ALTER TABLE po_items          ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants(id);
--> statement-breakpoint
ALTER TABLE po_deliveries     ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants(id);
--> statement-breakpoint
ALTER TABLE goods_receipts    ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants(id);
--> statement-breakpoint
ALTER TABLE gr_items          ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants(id);
--> statement-breakpoint

-- ── 2. Backfill headers via actor → users.tenant_id, then the demo-seed fallback ──────────────────────
UPDATE purchase_requests pr SET tenant_id = u.tenant_id
  FROM users u WHERE u.username = pr.requested_by AND pr.tenant_id IS NULL;
--> statement-breakpoint
UPDATE purchase_requests SET tenant_id = (SELECT id FROM tenants WHERE code = 'OSHINEI')
  WHERE tenant_id IS NULL AND requested_by = 'procurement-demo';
--> statement-breakpoint

UPDATE purchase_orders po SET tenant_id = u.tenant_id
  FROM users u WHERE u.username = po.created_by AND po.tenant_id IS NULL;
--> statement-breakpoint
UPDATE purchase_orders SET tenant_id = (SELECT id FROM tenants WHERE code = 'OSHINEI')
  WHERE tenant_id IS NULL AND created_by = 'procurement-demo';
--> statement-breakpoint

UPDATE goods_receipts gr SET tenant_id = u.tenant_id
  FROM users u WHERE u.username = gr.received_by AND gr.tenant_id IS NULL;
--> statement-breakpoint
-- fallback: inherit from the PO this receipt was issued against
UPDATE goods_receipts gr SET tenant_id = po.tenant_id
  FROM purchase_orders po WHERE po.po_no = gr.po_no AND gr.tenant_id IS NULL;
--> statement-breakpoint
UPDATE goods_receipts SET tenant_id = (SELECT id FROM tenants WHERE code = 'OSHINEI')
  WHERE tenant_id IS NULL AND received_by = 'procurement-demo';
--> statement-breakpoint

-- ── 3. Backfill line/child tables from their parent header ─────────────────────────────────────────────
UPDATE pr_items i SET tenant_id = h.tenant_id FROM purchase_requests h WHERE h.id = i.pr_id AND i.tenant_id IS NULL;
--> statement-breakpoint
UPDATE po_items i SET tenant_id = h.tenant_id FROM purchase_orders h WHERE h.id = i.po_id AND i.tenant_id IS NULL;
--> statement-breakpoint
UPDATE po_deliveries d SET tenant_id = h.tenant_id FROM purchase_orders h WHERE h.id = d.po_id AND d.tenant_id IS NULL;
--> statement-breakpoint
UPDATE gr_items i SET tenant_id = h.tenant_id FROM goods_receipts h WHERE h.id = i.gr_id AND i.tenant_id IS NULL;
--> statement-breakpoint

-- ── 4. Fail loudly (not silently) if any row couldn't be attributed ────────────────────────────────────
DO $$
DECLARE orphaned int;
BEGIN
  SELECT
    (SELECT count(*) FROM purchase_requests WHERE tenant_id IS NULL) +
    (SELECT count(*) FROM pr_items WHERE tenant_id IS NULL) +
    (SELECT count(*) FROM purchase_orders WHERE tenant_id IS NULL) +
    (SELECT count(*) FROM po_items WHERE tenant_id IS NULL) +
    (SELECT count(*) FROM po_deliveries WHERE tenant_id IS NULL) +
    (SELECT count(*) FROM goods_receipts WHERE tenant_id IS NULL) +
    (SELECT count(*) FROM gr_items WHERE tenant_id IS NULL)
  INTO orphaned;
  IF orphaned > 0 THEN
    RAISE EXCEPTION '0387: % row(s) across the P2P tables could not be attributed to a tenant — backfill rule needs to be extended before RLS goes live', orphaned;
  END IF;
END $$;
--> statement-breakpoint

-- ── 5. Leading tenant_id index per table (tenant-idx CI gate) ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_purchase_requests_tenant ON purchase_requests (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pr_items_tenant          ON pr_items (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_purchase_orders_tenant   ON purchase_orders (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_po_items_tenant          ON po_items (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_po_deliveries_tenant     ON po_deliveries (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_goods_receipts_tenant    ON goods_receipts (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gr_items_tenant          ON gr_items (tenant_id);
--> statement-breakpoint

-- ── 6. Enable + force RLS with the CANONICAL org-clause policy body (docs/ops/tenancy-model.md — this is
-- the form every new tenant_id table must use, not the plain 0002 body, or org-sharing silently regresses).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'purchase_requests', 'pr_items', 'purchase_orders', 'po_items',
      'po_deliveries', 'goods_receipts', 'gr_items'
    ]) AS table_name
  LOOP
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

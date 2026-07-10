-- 0299_kds_recall_count — KDS depth (POS-4). Add a per-line recall counter to dine_in_order_items so the
-- kitchen display can show an all-day recall count per station (a line recalled off the pass increments it).
-- dine_in_order_items is an existing tenant-scoped table (tenant_id column) — the 0232-canonical
-- tenant_isolation RLS policy already covers it, and the table-level app_user GRANT covers new columns,
-- so no RLS loop / GRANT re-apply is needed for a plain column add.
ALTER TABLE dine_in_order_items ADD COLUMN IF NOT EXISTS recall_count integer NOT NULL DEFAULT 0;

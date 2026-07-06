-- 0250_items_barcode — a real barcode/GTIN on the item master so a hardware scanner resolves an item by an
-- EXACT scan (not a fuzzy name/code search). Nullable; an item's `item_id` remains its business code. `items`
-- is a shared master (no tenant_id column) so no RLS loop applies. The index backs the exact-match scan lookup.
ALTER TABLE items ADD COLUMN IF NOT EXISTS barcode text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_items_barcode ON items (barcode);

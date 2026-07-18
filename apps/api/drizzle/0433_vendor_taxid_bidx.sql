-- 0433_vendor_taxid_bidx — blind-index companion column for the encrypted vendors.tax_id
-- (encrypted-column.ts convention: HMAC-SHA256 keyed off APP_ENC_KEY via blindIndex(), stored in
-- <col>_bidx, queried by equality). Removes the AP-intake mapper's 500-vendor decrypt-and-scan ceiling:
-- mapToPo now looks the 13-digit tax id up by index first and falls back to the decrypted scan (which
-- SELF-HEALS the column — no decrypting backfill is possible in a migration, app-level ciphertext).
-- A blind-index hit is always re-verified against the decrypted value, so a stale index can never
-- mis-map a vendor. No RLS change (vendors keeps its custom vendor_tenant_read/write policies).
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS tax_id_bidx text;
CREATE INDEX IF NOT EXISTS idx_vendors_taxid_bidx ON vendors (tax_id_bidx) WHERE tax_id_bidx IS NOT NULL;

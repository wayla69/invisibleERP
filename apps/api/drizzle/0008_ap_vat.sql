-- Phase 13 — Tier 2 tax reports: store input VAT on AP bills so รายงานภาษีซื้อ + ภ.พ.30 are exact
-- (was derived 7/107 at GL time only). Backfill legacy rows with the inclusive split.
ALTER TABLE ap_transactions ADD COLUMN IF NOT EXISTS vat_amount numeric(14,2);
UPDATE ap_transactions SET vat_amount = round((amount * 7.0 / 107.0)::numeric, 2) WHERE vat_amount IS NULL AND amount IS NOT NULL;

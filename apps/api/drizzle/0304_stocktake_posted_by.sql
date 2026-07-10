-- 0304 — Record WHO posted a stocktake variance (SoD R11 evidence, needed by the hub replay).
--
-- `postStocktake` enforces that the poster differs from the counter (SOD_SELF_APPROVAL) but stored only
-- the counter, so after the fact the segregation could not be *evidenced* from the document — and a
-- store-hub replay (BRANCH-07) would post as the machine principal `hub-sync`, erasing the two real
-- humans entirely. Persist the poster so both sides of R11 survive on the document, on either ledger.
ALTER TABLE stocktakes ADD COLUMN IF NOT EXISTS posted_by TEXT;
--> statement-breakpoint
ALTER TABLE stocktakes ADD COLUMN IF NOT EXISTS posted_at TIMESTAMPTZ;

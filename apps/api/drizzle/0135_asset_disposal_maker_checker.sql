-- 0135 — Asset disposal maker-checker (FA-09). A disposal now posts its GL entry as a DRAFT (excluded
-- from balances) and flags the asset disposal_pending WITHOUT marking it disposed; a DIFFERENT user must
-- approve before the disposal is effective (status → disposed, revaluation surplus recycled). This is the
-- asset-stripping control — one person can no longer write an asset off the books and pocket the proceeds.
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS disposal_pending boolean NOT NULL DEFAULT false;
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS disposal_requested_by text;
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS disposal_approved_by text;

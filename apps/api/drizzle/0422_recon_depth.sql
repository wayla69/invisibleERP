-- 0422_recon_depth — reconciliation workspace depth (docs/50 Wave 4 B4; extends REC-01, no new table).
-- Lifts the recon_periods workspace from item-matching toward balance-sheet certification: a per-account
-- ROLL-FORWARD (opening → activity → closing, computed from the posted GL so it ties to the TB by
-- construction), a RISK RATING that drives review depth, and AUTO-CERTIFICATION for the provably-safe
-- class (LOW risk + zero opening/activity/closing) — logged and flagged, while the manual certify path
-- and REC-01's preparer ≠ certifier SoD stay byte-identical. Additive columns only (table already
-- tenant-scoped under the canonical RLS).
ALTER TABLE recon_periods ADD COLUMN IF NOT EXISTS opening_balance numeric(18,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE recon_periods ADD COLUMN IF NOT EXISTS activity numeric(18,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE recon_periods ADD COLUMN IF NOT EXISTS closing_balance numeric(18,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE recon_periods ADD COLUMN IF NOT EXISTS risk_rating text NOT NULL DEFAULT 'medium';
--> statement-breakpoint
ALTER TABLE recon_periods ADD COLUMN IF NOT EXISTS auto_certified boolean NOT NULL DEFAULT false;

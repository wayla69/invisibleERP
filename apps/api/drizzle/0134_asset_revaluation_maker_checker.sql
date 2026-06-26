-- 0134 — Asset revaluation/impairment maker-checker (FA-08). A revaluation now posts its GL entry as a
-- DRAFT (excluded from balances) and records status 'PendingApproval' WITHOUT re-valuing the asset; a
-- DIFFERENT user must approve before the JE is effective and the register's carrying value moves (SoD,
-- reusing the GL-05 ledger approval). Records who/when approved. Historical rows default to 'Posted'.
ALTER TABLE asset_revaluations ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Posted';
ALTER TABLE asset_revaluations ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE asset_revaluations ADD COLUMN IF NOT EXISTS approved_at timestamptz;

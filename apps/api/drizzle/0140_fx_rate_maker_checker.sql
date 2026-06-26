-- 0140 — FX rate maker-checker (FX-04). A manually-entered FX rate is now a REQUEST that is NOT usable for
-- revaluation or reporting until a DIFFERENT user approves it. A fat-fingered rate (USD 36 keyed as 63) can no
-- longer flow straight into a revaluation JE that mis-states earnings/equity. Externally-sourced rates (a feed
-- with an explicit non-manual source) are auto-approved. status DEFAULT 'Approved' keeps every existing row +
-- any feed insert usable with no behaviour change; only manual entries land as PendingApproval.
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Approved'; -- Approved | PendingApproval | Rejected
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS requested_by text;
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS approved_by text;  -- checker — must differ from requested_by
ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS approved_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_fxrate_status ON fx_rates (tenant_id, status);

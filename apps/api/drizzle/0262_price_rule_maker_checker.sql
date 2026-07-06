-- Price / promotion rule maker-checker (maker-checker audit gap G6, SoD R10). A price/discount rule that
-- applies live at the till and in quotes can no longer be activated by its author alone (set a price, then
-- sell at it). A new/changed rule is staged 'PendingApproval' and left inactive (the discount engine reads
-- only active=true rules), and a DIFFERENT user activates it. These columns carry the staged state on the
-- existing price_rules table (already tenant-scoped + RLS; adding columns needs no policy change).
-- Existing rows default to 'Active' so live rules are unaffected.
ALTER TABLE price_rules ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Active';
ALTER TABLE price_rules ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE price_rules ADD COLUMN IF NOT EXISTS approved_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_price_rules_status ON price_rules (tenant_id, status);

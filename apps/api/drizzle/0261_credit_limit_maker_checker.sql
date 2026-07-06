-- Customer credit-limit change maker-checker (maker-checker audit gap G7, control REV-08). A credit-limit
-- change is a fraud-relevant master-data edit (raise the limit, then sell on credit — SoD R09). It is no
-- longer applied by the requester: the change is staged as a PendingApproval credit_events row and applied
-- only when a DIFFERENT user (approvals/exec) approves it. These columns carry the staged request state on
-- the existing credit_events table (already tenant-scoped + RLS; adding columns needs no policy change).
ALTER TABLE credit_events ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'applied';
ALTER TABLE credit_events ADD COLUMN IF NOT EXISTS req_no text;
ALTER TABLE credit_events ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE credit_events ADD COLUMN IF NOT EXISTS approved_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_credit_events_status ON credit_events (tenant_id, status);

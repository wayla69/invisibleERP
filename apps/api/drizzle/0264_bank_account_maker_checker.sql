-- 0264 — G9 (maker-checker audit): bank-account creation is now dual-controlled.
-- A new bank account (account no + GL mapping + opening balance) is created 'PendingApproval' and cannot
-- be used to bank cash until a DISTINCT approver activates it (403 SOD_VIOLATION on self-approval).
-- Existing accounts backfill to 'Approved' so they stay usable. bank_accounts already carries tenant_id
-- (RLS + the (tenant_id, account_no) unique), so no new RLS loop / index is required — plain column adds.
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Approved';
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS requested_by text;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS approved_by text;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS approved_at timestamptz;

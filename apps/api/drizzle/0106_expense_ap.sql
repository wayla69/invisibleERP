-- 0106 — ESS expense reimbursement now raises an AP payable on approval. Track the AP txn on the claim.
-- (Column add on an existing tenant-scoped table — RLS already applies, no policy loop needed.)
ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS ap_txn_no text;

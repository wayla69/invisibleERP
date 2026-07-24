-- 0432_ap_intake_lines — extracted invoice LINE ITEMS (Claude vision, EXP-10 quality round) stored on
-- the intake for human review + bill-draft pre-fill. Draft detail ONLY: the lines are NOT fed to the
-- 3-way match (EXP-01/EXP-10 header-level match unchanged — vision lines carry no internal item_id).
-- ap_invoice_intakes is already tenant-scoped (canonical RLS); a new column inherits the row policy.
ALTER TABLE ap_invoice_intakes ADD COLUMN IF NOT EXISTS lines jsonb;

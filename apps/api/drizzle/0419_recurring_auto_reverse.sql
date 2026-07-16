-- 0419_recurring_auto_reverse — auto-reversing accruals (docs/50 Wave 1 B2; extends GL-08/GL-17).
-- A month-end accrual template flagged auto_reverse='true' gets its posted entry automatically REVERSED
-- (lines flipped, Draft, maker-checker GL-05) by the recurring sweep's first run in the next business
-- month — so accruals never linger unreversed into the new period. Monthly-frequency templates only
-- (enforced at create, AUTO_REVERSE_MONTHLY_ONLY). text 'true'/'false' mirrors the existing `active`
-- column's convention on this table. Existing rows default to 'false' (behaviour unchanged).
ALTER TABLE recurring_journals ADD COLUMN IF NOT EXISTS auto_reverse text DEFAULT 'false';

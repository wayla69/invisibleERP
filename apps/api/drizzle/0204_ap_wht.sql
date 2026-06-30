-- TAX-03 — withholding tax (ภ.ง.ด.3/53) taken at AP payment time.
-- Add the WHT capture columns to ap_payments: the income-type label, the rate, and the computed amount
-- (posted to GL 2361 "Vendor WHT Payable" at approval). ap_payments already carries tenant_id + RLS
-- (0xxx), so adding columns needs no new policy. Idempotent.
ALTER TABLE ap_payments ADD COLUMN IF NOT EXISTS wht_income_type TEXT;
ALTER TABLE ap_payments ADD COLUMN IF NOT EXISTS wht_rate   NUMERIC(6,4);
ALTER TABLE ap_payments ADD COLUMN IF NOT EXISTS wht_amount NUMERIC(14,2);

-- 0446_pos_age_restricted — age-restricted sale gate (docs/52 Phase 3c).
-- Alcohol / tobacco (Thailand: 20+) may not be sold to an under-age customer. An item carries a minimum age
-- (`items.min_age`, 0 = unrestricted, shared master → no RLS loop); a POS sale containing such an item must
-- carry an age check — the cashier attests they verified ID, or a customer birthdate proves the age — and the
-- sale records that it was age-verified (`cust_pos_sales.age_verified`) for the audit trail. A sale with no
-- age-restricted line is unaffected (`age_verified` stays false, no gate) — byte-identical.
ALTER TABLE items ADD COLUMN IF NOT EXISTS min_age integer NOT NULL DEFAULT 0;
ALTER TABLE cust_pos_sales ADD COLUMN IF NOT EXISTS age_verified boolean NOT NULL DEFAULT false;

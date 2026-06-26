-- Step 5 — demand-driven par levels. Branch replenishment (INV-05) already routes transfer-before-buy off a
-- STATIC per-branch reorder_point. This adds a lead_time_days per (branch,item) so the system can RECOMMEND
-- a demand-driven reorder point = avg daily usage (trailing window of cust_stock_log consumption) × lead
-- time × safety factor — flagging branches whose static buffer is too low for their actual run-rate.
-- branch_stock already has tenant_id + the 0002 RLS policy, so this additive column needs no RLS loop.
ALTER TABLE branch_stock ADD COLUMN IF NOT EXISTS lead_time_days integer NOT NULL DEFAULT 3;

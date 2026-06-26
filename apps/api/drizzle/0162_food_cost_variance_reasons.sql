-- Step 4 — reason-coded food-cost variance. The EOD count already records a per-ingredient theoretical-vs-
-- actual variance (cust_variance); attributing each to a normalized reason_code (WASTE/OVERSTOCK/SPOILAGE/
-- PORTIONING/THEFT/OTHER) + an optional station turns the baht variance into an ACTIONABLE lever — "Sauce
-- station is 8% over theoretical (portioning) → retrain". cust_variance already has tenant_id + the 0002 RLS
-- policy, so these additive columns need no RLS loop.
ALTER TABLE cust_variance ADD COLUMN IF NOT EXISTS reason_code text NOT NULL DEFAULT 'OTHER';
--> statement-breakpoint
ALTER TABLE cust_variance ADD COLUMN IF NOT EXISTS station text;

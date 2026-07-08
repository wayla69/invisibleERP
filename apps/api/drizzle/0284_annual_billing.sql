-- 0284_annual_billing (1.7): annual billing interval + multi-currency price list. DEFAULT-INERT —
-- billing_interval defaults 'monthly' and currency 'THB', so every existing subscription behaves exactly
-- as before; price_yearly NULL = the plan is not offered annually (checkout fails closed ANNUAL_NOT_OFFERED);
-- prices NULL = THB only (CURRENCY_NOT_OFFERED for anything else).
ALTER TABLE plans ADD COLUMN IF NOT EXISTS price_yearly NUMERIC(12,2);
--> statement-breakpoint
ALTER TABLE plans ADD COLUMN IF NOT EXISTS prices JSONB;
--> statement-breakpoint
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_interval TEXT DEFAULT 'monthly';
--> statement-breakpoint
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'THB';
--> statement-breakpoint
-- Backfill annual + USD prices for already-provisioned DBs (mirrors PLAN_SEED; seedPlans keeps them in
-- sync on fresh boots). Annual = 10× monthly (2 months free); USD illustrative (~฿34.5/$, pricing-rounded)
-- — market-entry defaults, tune after testing.
UPDATE plans SET price_yearly = 19000, prices = '{"USD": {"monthly": 55, "yearly": 550}}'::jsonb WHERE code = 'starter';
--> statement-breakpoint
UPDATE plans SET price_yearly = 99000, prices = '{"USD": {"monthly": 285, "yearly": 2850}}'::jsonb WHERE code = 'pro';

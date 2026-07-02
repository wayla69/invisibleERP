-- 0213_ab_holdout — Phase G2 (docs/25): A/B message variants + a holdout control group on the closed-loop
-- automation campaigns (campaign_sends already tracks coupon → redeemed_at → redeemed_value), plus body-only
-- A/B on loyalty_campaigns. Assignment is a deterministic (campaign_id, member_id) hash — reproducible, no
-- RNG. Additive nullable/defaulted columns on existing tenant-scoped tables (RLS already applies).
ALTER TABLE automation_campaigns ADD COLUMN IF NOT EXISTS variant_b_body text;
--> statement-breakpoint
ALTER TABLE automation_campaigns ADD COLUMN IF NOT EXISTS split_b_pct integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE automation_campaigns ADD COLUMN IF NOT EXISTS holdout_pct integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE campaign_sends ADD COLUMN IF NOT EXISTS variant text;
--> statement-breakpoint
ALTER TABLE loyalty_campaigns ADD COLUMN IF NOT EXISTS variant_b_body text;
--> statement-breakpoint
ALTER TABLE loyalty_campaigns ADD COLUMN IF NOT EXISTS split_b_pct integer NOT NULL DEFAULT 0;

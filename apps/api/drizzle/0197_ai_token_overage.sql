-- 0194 — AI token overage metering (panel Round-2, condition #3).
-- Records tokens consumed beyond a tenant's included daily cap so over-limit usage is billed, not given
-- away. Pairs with killing the "unlimited" Enterprise bucket (a finite ceiling in checkBudget).
ALTER TABLE ai_token_usage ADD COLUMN IF NOT EXISTS overage_tokens integer NOT NULL DEFAULT 0;

-- 0199 — AI overage pricing: ceiling + metered-overage tiers (PwC Capital Markets follow-up, panel #3).
-- (Renumbered 0198→0199: main merged 0198_project_health_snapshots concurrently.)
-- Connects the COGS meter (ai_token_usage.overage_tokens) to a price. Adds two plan-feature keys alongside
-- the existing finite included cap (ai_tokens_daily):
--   ai_tokens_daily_max         — hard daily ceiling (absolute cutoff; usage in (included, max] is metered).
--   ai_overage_rate_thb_per_1k  — THB billed per 1,000 overage tokens.
-- Idempotent jsonb merge so existing rows gain the keys without clobbering other features. BillingService.
-- seedPlans() also upserts these at startup; this migration backfills already-provisioned databases.
-- Illustrative values — finalized in docs/ops/pricing-and-ai-cogs.md (founder may overwrite).
UPDATE plans SET features = COALESCE(features, '{}'::jsonb) || '{"ai_tokens_daily_max": 0,       "ai_overage_rate_thb_per_1k": 0}'::jsonb  WHERE code IN ('free', 'starter');
UPDATE plans SET features = COALESCE(features, '{}'::jsonb) || '{"ai_tokens_daily_max": 500000,  "ai_overage_rate_thb_per_1k": 12}'::jsonb WHERE code = 'pro';
UPDATE plans SET features = COALESCE(features, '{}'::jsonb) || '{"ai_tokens_daily_max": 5000000, "ai_overage_rate_thb_per_1k": 8}'::jsonb  WHERE code = 'enterprise';

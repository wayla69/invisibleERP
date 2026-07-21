-- 0457: product-line SKUs (docs/53 C1) — per-branch billing quantity for the POS line.
-- POS-line plans (features.per_branch = true: pos_lite, pos_pro) price PER BRANCH: checkout multiplies
-- the plan's unit price by the subscription's purchased branch count, and branch-scaled quotas
-- (pos_txns_monthly) multiply the same way. NULL = 1 branch (every non-per-branch plan ignores this).
-- The four line-SKU plan rows themselves are seeded by seedPlans() at boot (plans is a platform table).
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "branches" integer;

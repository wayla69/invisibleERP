-- 0455: price grandfathering snapshot (docs/53 Q7 — makes the documented "existing subscriptions keep
-- their price" promise code-enforced BEFORE any future repricing).
-- Each subscription snapshots the plan's price at subscribe/plan-change time; charge paths read
-- COALESCE(snapshot, plan price), so a later PLAN_SEED repricing (seedPlans upserts plan rows at every
-- boot) no longer re-prices existing tenants. grandfathered_until NULL = indefinite price lock (cleared
-- only by a plan/interval change or an explicit platform-admin re-price at contractual renewal).
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "grandfathered_price" numeric;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "grandfathered_annual_price" numeric;
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "grandfathered_until" timestamp;

-- Backfill every existing subscription with its plan's CURRENT price (snapshot == list today ⇒ this
-- deploy changes no tenant's bill). On a fresh DB the plans table is empty until the boot seed runs —
-- the UPDATE no-ops there and new subscriptions snapshot at creation instead.
UPDATE "subscriptions" s
SET "grandfathered_price" = p."price_monthly",
    "grandfathered_annual_price" = p."price_yearly"
FROM "plans" p
WHERE s."plan_code" = p."code" AND s."grandfathered_price" IS NULL;

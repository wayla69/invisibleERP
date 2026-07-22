-- docs/56 Track A (A1) — persist promo/price attribution on each demand forecast.
--
-- Additive columns on the existing scm_demand_forecasts (already tenant_id-scoped + RLS from 0459),
-- so no RLS loop / index change is needed. Null when no governed regressor applied to the series.
ALTER TABLE scm_demand_forecasts ADD COLUMN IF NOT EXISTS promo_uplift_pct numeric(10,4);
--> statement-breakpoint
ALTER TABLE scm_demand_forecasts ADD COLUMN IF NOT EXISTS price_elasticity numeric(10,4);
--> statement-breakpoint
ALTER TABLE scm_demand_forecasts ADD COLUMN IF NOT EXISTS regressors_used jsonb DEFAULT '[]'::jsonb;

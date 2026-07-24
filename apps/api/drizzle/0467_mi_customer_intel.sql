-- 0467_mi_customer_intel
-- docs/60 Phase 2 — Customer Intelligence (CLV / Churn / Next-Best-Action). The external Marketing
-- Intelligence platform computes per-customer predicted CLV, churn probability, and a next-best-action
-- code, and PUSHES them into the ERP (scope analytics:write). They land on customer_profiles as columns
-- SEPARATE from the ERP's own explainable churn_risk / predicted_ltv (Growth Engine G3) — exactly as
-- mi_rfm_segment stays distinct from rfm_segment — so the two engines never clobber each other.
--
-- Tenancy: customer_profiles already carries tenant_id + the canonical org RLS policy + grants (an
-- existing table). Adding nullable columns needs no RLS/GRANT change. A supporting index on
-- (tenant_id, mi_rfm_segment) backs the Phase 2 segment drill-down read.
ALTER TABLE "customer_profiles" ADD COLUMN IF NOT EXISTS "mi_clv" numeric(14, 2);        -- platform predicted 12-month CLV (฿)
ALTER TABLE "customer_profiles" ADD COLUMN IF NOT EXISTS "mi_churn_risk" numeric(5, 4);  -- platform churn probability [0,1]
ALTER TABLE "customer_profiles" ADD COLUMN IF NOT EXISTS "mi_nba" text;                   -- next-best-action code (WINBACK|UPSELL|VIP_CARE|REACTIVATE|…)

CREATE INDEX IF NOT EXISTS "idx_customer_profiles_mi_segment" ON "customer_profiles" ("tenant_id", "mi_rfm_segment");

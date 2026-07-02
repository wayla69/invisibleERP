-- 0214_predictive_scoring — Phase G3 (docs/25): explainable churn-risk (0..100) + predicted 12-month LTV,
-- computed inside CrmService.refreshProfile (the F2 sweep keeps them fresh) with a version stamp so an
-- auditor can tie every score to a documented formula (docs/ops/predictive-scoring.md). Additive nullable
-- columns on an existing tenant-scoped table (RLS already applies).
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS churn_risk integer;
--> statement-breakpoint
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS predicted_ltv numeric(14,2);
--> statement-breakpoint
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS score_version text;

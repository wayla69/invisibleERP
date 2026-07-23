-- docs/59 Track D (D1) — scheduled batch retrain.
--
-- Move the expensive forecast (cmdstan refit) OFF the interactive request path onto a schedulable job:
-- `scm_batch_retrain` forecasts every planning-enabled series and PERSISTS the reconciled sample paths,
-- which a later nightly plan consumes without re-forecasting (the quantiles alone are not additive, so
-- BoM explosion needs the K×H paths).
--
-- Two additive changes on EXISTING tables (no new table ⇒ no RLS loop / no app_user grant needed; both
-- already carry the canonical tenant_isolation policy + their leading (tenant_id, …) index):

-- 1. Persist the reconciled sample paths on each forecast row (NULL on pre-D1 rows + fallback points).
ALTER TABLE scm_demand_forecasts ADD COLUMN IF NOT EXISTS sample_paths jsonb;
--> statement-breakpoint

-- 2. Per-(tenant, run_date) idempotency for the retrain scope — mirrors uq_scm_nightly_run (0459), so a
-- duplicate job enqueue (multi-replica scheduler tick) cannot double-retrain.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scm_retrain_run ON scm_plan_runs (tenant_id, run_date)
  WHERE scope = 'retrain' AND status <> 'Failed';

-- 0201_ai_overage_billing_runs: monthly AI-overage billing ledger (Wave 1 — connect the meter to COLLECTION).
-- (Renumbered 0200→0201: main merged 0200_project_program concurrently.)
-- The ai_overage_billing scheduled job appends one Stripe invoice item per tenant per month for metered AI
-- overage; this table is its idempotency guard + audit trail: at most ONE charge per (tenant, billing_month).
-- Mirrors ai_token_usage (0178) — operator/job-written, app-scoped reads — so no RLS loop (the billing job is
-- an HQ/exec cross-tenant operator; the read endpoint filters by tenant in the service).
CREATE TABLE IF NOT EXISTS ai_overage_billing_runs (
  id                     BIGSERIAL PRIMARY KEY,
  tenant_id              BIGINT NOT NULL REFERENCES tenants(id),
  billing_month          TEXT NOT NULL,                    -- 'YYYY-MM' (Asia/Bangkok business month)
  overage_tokens         INTEGER NOT NULL DEFAULT 0,
  rate_thb_per_1k        NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency               TEXT NOT NULL DEFAULT 'THB',
  stripe_invoice_item_id TEXT,                             -- NULL when no Stripe key (mock) or no customer
  status                 TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'invoiced' (real) | 'recorded' (mock)
  processed_by           TEXT,
  processed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, billing_month)                        -- idempotency: one overage charge per tenant per month
);

-- 0281_usage_meters (1.5): generic usage metering beyond AI tokens — e-Tax documents + POS transactions.
-- Mirrors ai_token_usage (0178) / ai_overage_billing_runs (0201): operator/job-written, app-scoped reads, so
-- NO RLS loop (the billing job is an HQ/exec cross-tenant operator; the read endpoint filters by tenant in
-- the service). The UNIQUE (tenant_id, …) on each table also gives the tenant-leading index R1-1 requires.

CREATE TABLE IF NOT EXISTS usage_events (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
  meter      TEXT NOT NULL,                              -- 'etax_docs' | 'pos_txns'
  event_key  TEXT NOT NULL,                              -- natural idempotency key (doc_no / sale_no)
  period     TEXT NOT NULL,                              -- 'YYYY-MM' (Asia/Bangkok business month)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, meter, event_key)                   -- dedup one row per billable event + tenant-leading index
);
-- Counting per (tenant, meter, period) is the billing hot path.
CREATE INDEX IF NOT EXISTS usage_events_tenant_meter_period_idx ON usage_events (tenant_id, meter, period);

CREATE TABLE IF NOT EXISTS usage_overage_billing_runs (
  id                     BIGSERIAL PRIMARY KEY,
  tenant_id              BIGINT NOT NULL REFERENCES tenants(id),
  meter                  TEXT NOT NULL,
  billing_month          TEXT NOT NULL,                  -- 'YYYY-MM' (Asia/Bangkok business month)
  overage_units          INTEGER NOT NULL DEFAULT 0,
  rate_thb_per_unit      NUMERIC(10,2) NOT NULL DEFAULT 0,
  amount                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency               TEXT NOT NULL DEFAULT 'THB',
  stripe_invoice_item_id TEXT,                           -- NULL when no Stripe key (mock) or no customer
  status                 TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'invoiced' (real) | 'recorded' (mock)
  processed_by           TEXT,
  processed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, meter, billing_month)               -- idempotency: one overage charge per tenant/meter/month
);

-- app_user grants (interceptor runs under SET ROLE app_user). No RLS: platform/meter tables, cross-tenant job reads.
DO $$ BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
END $$;

-- Included monthly quota + per-unit overage price per plan (mirrors 0178/0199 for AI tokens). Illustrative
-- market-entry defaults — tune after testing. -1 = unlimited (enterprise).
UPDATE plans SET features = COALESCE(features, '{}'::jsonb) || '{"etax_docs_monthly": 0,    "pos_txns_monthly": 0,     "etax_overage_rate_thb_per_doc": 0, "pos_overage_rate_thb_per_txn": 0}'::jsonb WHERE code = 'free';
UPDATE plans SET features = COALESCE(features, '{}'::jsonb) || '{"etax_docs_monthly": 100,  "pos_txns_monthly": 3000,  "etax_overage_rate_thb_per_doc": 3, "pos_overage_rate_thb_per_txn": 0.5}'::jsonb WHERE code = 'starter';
UPDATE plans SET features = COALESCE(features, '{}'::jsonb) || '{"etax_docs_monthly": 1000, "pos_txns_monthly": 30000, "etax_overage_rate_thb_per_doc": 2, "pos_overage_rate_thb_per_txn": 0.3}'::jsonb WHERE code = 'pro';
UPDATE plans SET features = COALESCE(features, '{}'::jsonb) || '{"etax_docs_monthly": -1,   "pos_txns_monthly": -1,    "etax_overage_rate_thb_per_doc": 0, "pos_overage_rate_thb_per_txn": 0}'::jsonb WHERE code = 'enterprise';

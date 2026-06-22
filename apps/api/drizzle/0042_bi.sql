-- Phase 20 Batch 3 — BI + AI Copilot
-- bi_daily_snapshots: daily materialized KPI per tenant
-- report_subscriptions: scheduled recurring report delivery

CREATE TABLE IF NOT EXISTS bi_daily_snapshots (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          BIGINT NOT NULL REFERENCES tenants(id),
  snapshot_date      DATE   NOT NULL,
  total_sales        NUMERIC(18,4) DEFAULT 0,
  total_orders       BIGINT        DEFAULT 0,
  avg_order_value    NUMERIC(18,4) DEFAULT 0,
  gross_profit       NUMERIC(18,4) DEFAULT 0,
  gross_margin_pct   NUMERIC(8,4)  DEFAULT 0,
  open_ar            NUMERIC(18,4) DEFAULT 0,
  open_ap            NUMERIC(18,4) DEFAULT 0,
  inventory_value    NUMERIC(18,4) DEFAULT 0,
  pipeline_value     NUMERIC(18,4) DEFAULT 0,
  weighted_pipeline  NUMERIC(18,4) DEFAULT 0,
  created_at         TIMESTAMPTZ   DEFAULT now(),
  UNIQUE (tenant_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS report_subscriptions (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
  name          TEXT   NOT NULL,
  report_type   TEXT   NOT NULL,
  filters       JSONB  DEFAULT '{}',
  frequency     TEXT   NOT NULL,
  recipients    JSONB  DEFAULT '[]',
  is_active     BOOLEAN DEFAULT TRUE,
  last_run_at   TIMESTAMPTZ,
  next_run_at   TIMESTAMPTZ,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- RLS
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user;
  END IF;
END $$;

ALTER TABLE bi_daily_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_subscriptions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  -- bi_daily_snapshots
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='bi_daily_snapshots' AND policyname='bi_snapshot_isolation') THEN
    EXECUTE 'CREATE POLICY bi_snapshot_isolation ON bi_daily_snapshots USING (tenant_id = current_setting(''app.tenant_id'', TRUE)::BIGINT OR current_setting(''app.bypass_rls'', TRUE) = ''on'')';
  END IF;
  -- report_subscriptions
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='report_subscriptions' AND policyname='report_sub_isolation') THEN
    EXECUTE 'CREATE POLICY report_sub_isolation ON report_subscriptions USING (tenant_id = current_setting(''app.tenant_id'', TRUE)::BIGINT OR current_setting(''app.bypass_rls'', TRUE) = ''on'')';
  END IF;
END $$;

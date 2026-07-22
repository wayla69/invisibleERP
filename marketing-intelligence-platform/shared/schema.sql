-- Marketing Intelligence Platform — data-warehouse DDL (idempotent).
-- Three-layer warehouse: staging (raw/ingested) -> core (cleaned/derived) -> analytics (model outputs).
-- Run by shared.db_connection.ensure_schema() on service boot. This is the platform's OWN Postgres
-- (Railway add-on), NOT the ERP database — ERP data arrives via the ERP HTTP API (see erp_client.py).

CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS analytics;

-- ── STAGING ────────────────────────────────────────────────────────────────────────────────────────
-- Raw social-listening payloads exactly as pulled from each platform API (kept for replay/re-derivation).
CREATE TABLE IF NOT EXISTS staging.social_raw_feeds (
    id            BIGSERIAL PRIMARY KEY,
    platform      VARCHAR(20)  NOT NULL,               -- tiktok | x | instagram | facebook
    raw_payload   JSONB        NOT NULL,
    extracted_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_social_raw_platform_time ON staging.social_raw_feeds (platform, extracted_at);

-- Per-day, per-channel sales synced from the ERP (GET /api/v1/sales/daily). Dimension-key columns are
-- NOT NULL DEFAULT '' so the upsert grain key is stable.
CREATE TABLE IF NOT EXISTS staging.erp_sales_daily (
    biz_date     DATE          NOT NULL,
    product_sku  VARCHAR(80)   NOT NULL DEFAULT '',
    channel      VARCHAR(40)   NOT NULL DEFAULT '',    -- marketing channel / UTM (blank = organic/untagged)
    revenue      NUMERIC(14,2) NOT NULL DEFAULT 0,
    units_sold   INTEGER       NOT NULL DEFAULT 0,
    synced_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (biz_date, product_sku, channel)
);

-- Per-customer purchase facts synced from the ERP (GET /api/v1/customers/transactions) — the RFM base.
CREATE TABLE IF NOT EXISTS staging.erp_customer_facts (
    customer_no        VARCHAR(50)   PRIMARY KEY,
    order_count        INTEGER       NOT NULL DEFAULT 0,   -- Frequency
    total_spend        NUMERIC(14,2) NOT NULL DEFAULT 0,   -- Monetary
    avg_order_value    NUMERIC(14,2),
    first_order_date   DATE,
    last_order_date    DATE,                                -- Recency anchor
    synced_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ── CORE ───────────────────────────────────────────────────────────────────────────────────────────
-- Cleaned daily social sentiment, derived from staging.social_raw_feeds.
CREATE TABLE IF NOT EXISTS core.social_sentiment_trends (
    id                BIGSERIAL PRIMARY KEY,
    biz_date          DATE          NOT NULL,
    platform          VARCHAR(20)   NOT NULL,
    keyword_or_topic  VARCHAR(120)  NOT NULL DEFAULT '',
    mention_count     INTEGER       NOT NULL DEFAULT 0,
    engagement        BIGINT        NOT NULL DEFAULT 0,      -- likes+shares+comments (media var proxy)
    views             BIGINT        NOT NULL DEFAULT 0,
    ad_spend          NUMERIC(14,2) NOT NULL DEFAULT 0,      -- platform ad spend (the MMM spend lever / ROI base)
    sentiment_score   NUMERIC(4,3)  CHECK (sentiment_score IS NULL OR (sentiment_score BETWEEN -1 AND 1)),
    processed_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
    UNIQUE (biz_date, platform, keyword_or_topic)
);

-- Sentiment mapped to a customer (or demographic segment) — feeds the sentiment-weighted RFM multiplier.
CREATE TABLE IF NOT EXISTS core.customer_sentiment (
    customer_no          VARCHAR(50)  PRIMARY KEY,
    avg_sentiment_score  NUMERIC(4,3) CHECK (avg_sentiment_score IS NULL OR (avg_sentiment_score BETWEEN -1 AND 1)),
    refreshed_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ── ANALYTICS (model outputs) ──────────────────────────────────────────────────────────────────────
-- MMM run header (inputs + fit quality) + per-channel results.
CREATE TABLE IF NOT EXISTS analytics.mmm_runs (
    run_id       BIGSERIAL PRIMARY KEY,
    window_from  DATE,
    window_to    DATE,
    total_spend  NUMERIC(16,2),
    r2           NUMERIC(6,4),
    ridge_alpha  NUMERIC(12,4),
    params       JSONB,                                   -- per-channel adstock/saturation params
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS analytics.mmm_results (
    run_id                   BIGINT      NOT NULL REFERENCES analytics.mmm_runs(run_id) ON DELETE CASCADE,
    channel                  VARCHAR(50) NOT NULL,
    beta                     NUMERIC(16,6),
    spend                    NUMERIC(16,2),
    attributed_revenue       NUMERIC(16,2),
    contribution_pct         NUMERIC(6,2),
    roi                      NUMERIC(12,4),
    adstock_theta            NUMERIC(6,4),
    saturation               JSONB,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, channel)
);

-- Sentiment-weighted RFM segmentation per customer (latest run overwrites).
CREATE TABLE IF NOT EXISTS analytics.customer_rfm_segments (
    customer_no          VARCHAR(50) PRIMARY KEY,
    recency_days         INTEGER,
    frequency            INTEGER,
    monetary             NUMERIC(14,2),
    r_score              SMALLINT,
    f_score              SMALLINT,
    m_score              SMALLINT,
    base_rfm_score       NUMERIC(6,2),
    sentiment_score      NUMERIC(4,3),
    sentiment_multiplier NUMERIC(5,3),
    weighted_rfm_score   NUMERIC(8,3),
    segment              VARCHAR(40),
    -- Customer Intelligence (docs/60 Phase 2) — per-customer forward-looking scores pushed to the ERP
    -- (mi_clv / mi_churn_risk / mi_nba). Interpretable first cut; a BG/NBD + churn classifier is governed
    -- under Phase 4. Nullable so a fresh run without sentiment still writes the RFM base.
    predicted_clv        NUMERIC(14,2),   -- 12-month forward value proxy (฿)
    churn_probability    NUMERIC(5,4),    -- [0,1]
    next_best_action     VARCHAR(40),     -- WINBACK|UPSELL|VIP_CARE|REACTIVATE|RETAIN|NURTURE|CROSS_SELL
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- TOWS strategy matrix (internal MMM/RFM x external sentiment).
CREATE TABLE IF NOT EXISTS analytics.tows_matrix (
    id             BIGSERIAL PRIMARY KEY,
    run_id         BIGINT,
    quadrant       VARCHAR(2)  NOT NULL,                  -- SO | ST | WO | WT
    factor         TEXT        NOT NULL,
    recommendation TEXT        NOT NULL,
    priority       SMALLINT    NOT NULL DEFAULT 3,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

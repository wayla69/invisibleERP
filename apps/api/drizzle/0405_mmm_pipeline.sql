-- docs/48 — Marketing Mix Modeling (MMM) staging → core → analytics pipeline. New bounded context; see
-- docs/48-marketing-mix-modeling-plan.md. The original design draft used three separate Postgres schemas
-- (staging/core/analytics) with no tenant scoping; this codebase is single-schema (public) with mandatory
-- per-table RLS, so all six tables live in public, are tenant-scoped, and get the canonical org-clause
-- tenant_isolation policy (0232/0399 form) + a leading (tenant_id, …) index (tenant-idx gate).

-- ── STAGING ────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mmm_social_raw_feeds (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  platform text NOT NULL,                        -- tiktok | x | instagram | facebook | …
  raw_payload jsonb NOT NULL,
  extracted_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mmm_social_raw_feeds_tenant ON mmm_social_raw_feeds (tenant_id, platform, extracted_at);
--> statement-breakpoint

-- Dimension-key columns (product_sku/utm_source/promo_code) are NOT NULL DEFAULT '' — a warehouse grain key
-- carries no NULLs, so the composite unique index + onConflict upsert stay stable across PGlite/Postgres.
CREATE TABLE IF NOT EXISTS mmm_sales_daily (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  biz_date date NOT NULL,
  product_sku text NOT NULL DEFAULT '',
  revenue numeric(14,2) NOT NULL DEFAULT '0',
  units_sold integer NOT NULL DEFAULT 0,
  utm_source text NOT NULL DEFAULT '',
  promo_code text NOT NULL DEFAULT '',
  ingested_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mmm_sales_daily_tenant ON mmm_sales_daily (tenant_id, biz_date);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_mmm_sales_daily
  ON mmm_sales_daily (tenant_id, biz_date, product_sku, utm_source, promo_code);
--> statement-breakpoint

-- ── CORE ───────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mmm_sentiment_trends (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  biz_date date NOT NULL,
  platform text NOT NULL,
  keyword_or_topic text NOT NULL DEFAULT '',
  mention_count integer NOT NULL DEFAULT 0,
  sentiment_score numeric(3,2) CHECK (sentiment_score IS NULL OR (sentiment_score >= -1 AND sentiment_score <= 1)),
  processed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mmm_sentiment_trends_tenant ON mmm_sentiment_trends (tenant_id, biz_date);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_mmm_sentiment_trends
  ON mmm_sentiment_trends (tenant_id, biz_date, platform, keyword_or_topic);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS mmm_customer_behavior (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  customer_no text NOT NULL,                     -- → customer_master.customer_no (business key)
  last_purchase_date date,
  total_orders integer NOT NULL DEFAULT 0,
  total_spend numeric(14,2) NOT NULL DEFAULT '0',
  avg_social_sentiment_interaction numeric(3,2),
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mmm_customer_behavior_tenant ON mmm_customer_behavior (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_mmm_customer_behavior ON mmm_customer_behavior (tenant_id, customer_no);
--> statement-breakpoint

-- ── ANALYTICS ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mmm_model_runs (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  run_no text NOT NULL,                          -- MMM-YYYYMMDD-NNN
  window_days integer NOT NULL,
  total_spend numeric(14,2) NOT NULL DEFAULT '0',
  spend_by_channel jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'complete',        -- complete | error
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mmm_model_runs_tenant ON mmm_model_runs (tenant_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_mmm_model_runs ON mmm_model_runs (tenant_id, run_no);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS mmm_channel_results (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  run_id bigint NOT NULL REFERENCES mmm_model_runs(id),
  channel text NOT NULL,
  spend numeric(14,2) NOT NULL DEFAULT '0',
  attributed_revenue numeric(14,2) NOT NULL DEFAULT '0',
  roi numeric(8,2),
  sales_lift_contribution numeric(5,2),
  optimal_budget_allocation numeric(14,2)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mmm_channel_results_tenant ON mmm_channel_results (tenant_id, run_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_mmm_channel_results ON mmm_channel_results (tenant_id, run_id, channel);
--> statement-breakpoint

-- app_user grants + the CANONICAL org-scoped tenant_isolation policy (0232/0399 form) for the six new
-- tables. Idempotent; runs on PGlite + Postgres alike (the DO-loop is enumerated over the tenant_id column,
-- so it self-selects exactly the tables added above plus any pre-existing tenant table — harmless re-apply).
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'', true), '''') = ''on'''
      || '        OR tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::bigint'
      || '        OR (nullif(current_setting(''app.org_id'', true), '''') IS NOT NULL'
      || '            AND tenant_id IN (SELECT id FROM tenants WHERE org_id = nullif(current_setting(''app.org_id'', true), '''')::bigint)))',
      r.table_name);
  END LOOP;
END $$;

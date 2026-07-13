-- docs/47 — reputation & external analytics ingestion (Google Maps reviews, GA4). New bounded context;
-- see docs/47-reputation-analytics-plan.md. OAuth tokens are stored via the encrypted-column type
-- (application-layer AES-256-GCM) — the columns below are plain `text` at the DB level.

CREATE TABLE IF NOT EXISTS reputation_connections (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  platform text NOT NULL,                       -- google_maps | google_analytics
  status text NOT NULL DEFAULT 'active',        -- active | error | revoked
  google_account_email text,
  access_token_enc text,
  refresh_token_enc text,
  token_expires_at timestamptz,
  scope text,
  external_refs jsonb NOT NULL DEFAULT '[]',
  last_synced_at timestamptz,
  last_error text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS reputation_connections_tenant_platform ON reputation_connections (tenant_id, platform);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS reputation_oauth_state (
  state text PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  created_by text NOT NULL,
  platform text NOT NULL,
  code_verifier text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS external_reviews (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  platform text NOT NULL,
  location_ref text NOT NULL,
  external_review_id text NOT NULL,
  author_name text,
  author_photo_url text,
  rating integer,
  comment text,
  review_create_time timestamptz,
  review_update_time timestamptz,
  reply_comment text,
  reply_update_time timestamptz,
  synced_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS external_reviews_tenant_platform_id ON external_reviews (tenant_id, platform, external_review_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS external_reviews_tenant_rating ON external_reviews (tenant_id, rating);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS analytics_daily_snapshots (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  property_ref text NOT NULL,
  metric_date date NOT NULL,
  sessions integer DEFAULT 0,
  active_users integer DEFAULT 0,
  conversions integer DEFAULT 0,
  total_revenue numeric(14,2) DEFAULT '0',
  engagement_rate numeric(6,4),
  top_channel_group text,
  raw jsonb DEFAULT '{}',
  synced_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS analytics_snapshots_tenant_property_date ON analytics_daily_snapshots (tenant_id, property_ref, metric_date);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232/0399 form) for the
-- four new tables. Idempotent; runs on PGlite + Postgres alike.
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

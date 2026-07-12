-- 0366_channel_customer_refs — G1 (docs/45): marketplace-to-member identity capture (MKT-13 control).
-- Delivery-aggregator buyers (Grab / LINE MAN / foodpanda / Robinhood) are anonymous today: the webhook
-- ingest keeps only a display name. This table maps a STABLE external customer reference to a loyalty
-- member so repeat marketplace buyers accrue to one profile:
--   • ref_hash    — SHA-256 over `<platform>:<normalized external customer id|phone>`. The RAW marketplace
--                   identifier is NEVER stored (PDPA data-minimization; mirrors the security-review
--                   fail-closed posture) — capture hashes at the ingest edge and only the hash persists.
--   • member_id   — pos_members soft FK; NULL until the member links (QR self-service with explicit
--                   consent capture, or staff link with attested consent) — MKT-13.
--   • order_count / first_seen_at / last_seen_at / last_order_no — repeat-buyer signal for CRM even
--                   while unlinked (no PII: hash + counters only).
-- Once linked, every later ingest for the same (tenant, platform, ref_hash) auto-attaches
-- dine_in_orders.member_id, so guest dining profiles + loyalty attribution accrue automatically.
CREATE TABLE IF NOT EXISTS channel_customer_refs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  platform text NOT NULL,                 -- grab | lineman | foodpanda | robinhood
  ref_hash text NOT NULL,                 -- sha256 hex; raw external identifier is never persisted
  member_id bigint,                       -- pos_members soft FK; NULL = not yet linked
  order_count bigint NOT NULL DEFAULT 1,
  first_seen_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now(),
  last_order_no text,
  linked_at timestamptz,
  link_source text,                       -- qr | staff
  linked_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_customer_refs ON channel_customer_refs (tenant_id, platform, ref_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_channel_customer_refs_tenant ON channel_customer_refs (tenant_id, member_id);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new table
-- gets RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

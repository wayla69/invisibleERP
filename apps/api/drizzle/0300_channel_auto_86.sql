-- 0300_channel_auto_86 — Auto-86 (out-of-stock) push to delivery aggregators (POS-7, INV-14).
-- When the reactive auto-86 (LockingService.recomputeAvailability) flips a recipe-backed dish
-- unavailable because an ingredient depleted — or available again on restock — that transition is
-- pushed to every connected aggregator (Grab / LINE MAN / Foodpanda / Robinhood) via the existing
-- channel-adapter provider (setItemAvailability). Two tenant-scoped tables back it:
--  (1) channel_item_availability — the CURRENT per-(tenant,platform,sku) availability state we have
--      pushed to the aggregator. Idempotency lives here: a transition is only pushed when the desired
--      state differs from the stored state, so a no-op recompute never spams the partner API.
--  (2) channel_item_86_log — an append-only AUDIT of every 86 / un-86 transition actually pushed
--      (reason, push outcome/ref, actor), so an auditor can prove the store never kept offering an
--      un-cookable item.
CREATE TABLE IF NOT EXISTS channel_item_availability (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  platform text NOT NULL,                       -- grab | lineman | foodpanda | robinhood
  sku text NOT NULL,
  available boolean NOT NULL DEFAULT true,       -- current state pushed to the aggregator (false = 86'd)
  reason text,
  last_push_ok boolean,
  last_push_ref text,
  last_synced_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT uq_channel_item_avail UNIQUE (tenant_id, platform, sku)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_channel_item_avail_tenant ON channel_item_availability (tenant_id, platform, sku);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS channel_item_86_log (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  platform text NOT NULL,
  sku text NOT NULL,
  action text NOT NULL,                          -- '86' (pause) | 'un-86' (resume)
  reason text,
  push_ok boolean,
  push_ref text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_channel_item_86_log_tenant ON channel_item_86_log (tenant_id, created_at);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new tables
-- get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

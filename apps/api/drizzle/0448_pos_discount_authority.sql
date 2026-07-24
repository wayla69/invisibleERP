-- 0448_pos_discount_authority — per-line manual-discount / price-override approval routing (docs/52 Phase 4b).
-- A manual line or bill discount above the shop's configured authority must be AUTHORIZED by a supervisor at
-- the till (maker-checker; SoD R08 — the same duty that authorizes refunds/voids, segregated from selling)
-- rather than applied freely. `pos_discount_settings` holds the per-tenant caps (both NULL = no cap, the
-- pre-4b behaviour — a shop OPTS IN to discount governance); a `discount` authorization is a `pos_overrides`
-- row whose `authorized_pct` bounds the over-cap discount it covers and whose `approved_by` is the
-- authenticated supervisor. Both tables are TENANT-SCOPED — `pos_discount_settings` gets the canonical
-- 0232-form tenant_isolation RLS + a tenant index + app_user grant (`pos_overrides` is already covered).
ALTER TABLE pos_overrides ADD COLUMN IF NOT EXISTS authorized_pct numeric(6,3);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pos_discount_settings (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  max_line_discount_pct numeric(6,3),   -- NULL = no per-line cap
  max_bill_discount_pct numeric(6,3),   -- NULL = no bill cap
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pos_discount_settings_tenant ON pos_discount_settings (tenant_id);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
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

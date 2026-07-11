-- 0330_service_contract_renewal — SVC-3 (Track-2 audit): Service Contract Renewal & Expiry management.
-- service_contracts have end_date/status but NO renewal workflow, expiry alerting or renewal-price uplift
-- control. This adds, ALONGSIDE the existing contract/SLA/subscription surfaces (no change to those paths):
--   • Four additive nullable/defaulted columns on service_contracts (renewal_status, auto_renew,
--     renewal_uplift_pct, renewed_to_contract_id self-FK) — existing inserts are unaffected.
--   • contract_renewals — a proposed renewal of a contract; a renewal whose uplift_pct exceeds the tenant
--     threshold, or an auto-renew that would raise price, is parked `pending` and the successor contract is
--     created ONLY when a DIFFERENT service/exec user approves (SVC-02 maker-checker). Within-threshold
--     renewals auto-approve and create the successor immediately.
--   • contract_renewal_settings — the per-tenant max_auto_uplift_pct threshold (default 5%), change-gated.
-- Each new table is tenant-scoped: a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation
-- RLS policy (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
ALTER TABLE service_contracts ADD COLUMN IF NOT EXISTS renewal_status text NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE service_contracts ADD COLUMN IF NOT EXISTS auto_renew boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE service_contracts ADD COLUMN IF NOT EXISTS renewal_uplift_pct numeric(6,3) NOT NULL DEFAULT '0';
--> statement-breakpoint
ALTER TABLE service_contracts ADD COLUMN IF NOT EXISTS renewed_to_contract_id bigint REFERENCES service_contracts(id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS contract_renewals (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  renewal_no text NOT NULL UNIQUE,
  contract_id bigint NOT NULL REFERENCES service_contracts(id),
  proposed_start date NOT NULL,
  proposed_end date NOT NULL,
  base_value numeric(18,4) NOT NULL DEFAULT '0',
  uplift_pct numeric(6,3) NOT NULL DEFAULT '0',
  new_value numeric(18,4) NOT NULL DEFAULT '0',
  auto_renew boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reason text,
  requested_by text,
  approved_by text,
  created_at timestamptz DEFAULT now(),
  decided_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_contract_renewals_tenant ON contract_renewals (tenant_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_contract_renewals_contract ON contract_renewals (contract_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS contract_renewal_settings (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  max_auto_uplift_pct numeric(6,3) NOT NULL DEFAULT '5',
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_renewal_settings_tenant ON contract_renewal_settings (tenant_id);
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

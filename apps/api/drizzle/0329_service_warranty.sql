-- 0329_service_warranty — SVC-2 (Warranty & Entitlement registry): net-new after-sales foundation, distinct
-- from the #666 subscription/SLA service spine. Adds three tenant-scoped tables:
--   • warranty_terms   — per-tenant catalogue of warranty offerings (coverage_months + coverage_type).
--   • installed_base    — the serialized-unit / asset registry: a sold unit (serial, unique per tenant) tied
--                         to a customer + item + warranty term, with a computed warranty_end window.
--   • warranty_claims   — a claim against an installed_base unit, gated by the SVC-01 coverage-authorization
--                         control (in-coverage → auto-authorized free; out-of-coverage free service needs a
--                         DIFFERENT authorizer than the requester → SOD_SELF_APPROVAL).
-- Each gets a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation RLS policy (re-applied
-- via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS warranty_terms (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  term_code text NOT NULL,
  name text NOT NULL,
  coverage_months bigint NOT NULL DEFAULT 12,
  coverage_type text NOT NULL DEFAULT 'full',
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_warranty_terms_tenant ON warranty_terms (tenant_id, active);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_warranty_terms_code ON warranty_terms (tenant_id, term_code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS installed_base (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  serial_no text NOT NULL,
  item_code text NOT NULL,
  item_id bigint,
  customer_id bigint,
  customer_name text,
  sold_date date NOT NULL,
  warranty_term_id bigint REFERENCES warranty_terms(id),
  warranty_start date NOT NULL,
  warranty_end date NOT NULL,
  coverage_type text NOT NULL DEFAULT 'full',
  status text NOT NULL DEFAULT 'active',
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_installed_base_tenant ON installed_base (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_installed_base_serial ON installed_base (tenant_id, serial_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_installed_base_end ON installed_base (tenant_id, warranty_end);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS warranty_claims (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  claim_no text NOT NULL,
  installed_base_id bigint NOT NULL REFERENCES installed_base(id),
  reported_date date NOT NULL,
  fault text NOT NULL,
  coverage_kind text NOT NULL DEFAULT 'full',
  disposition text,
  status text NOT NULL DEFAULT 'pending',
  is_in_coverage boolean NOT NULL DEFAULT false,
  charge numeric(18,4) NOT NULL DEFAULT '0',
  requested_by text,
  authorized_by text,
  reject_reason text,
  created_at timestamptz DEFAULT now(),
  decided_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_warranty_claims_tenant ON warranty_claims (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_warranty_claims_no ON warranty_claims (tenant_id, claim_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_warranty_claims_unit ON warranty_claims (installed_base_id);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the three new
-- tables get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

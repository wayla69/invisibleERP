-- 0328_cpq_discount_approval — SVC-1 (CPQ-01): CPQ discount-approval & margin-floor control.
-- Quotes previously carried no cost, no margin and no discount-approval workflow (a rep could quote any
-- total). This migration adds the maker-checker spine:
--   • quote_lines.unit_cost — a COGS basis per line, so a quote's margin% is computable.
--   • quotes: discount_pct / margin_pct (computed on send), requires_approval, approved_by / approved_at.
--   • cpq_settings — a per-tenant floor (min_margin_pct default 20 / max_discount_pct default 15).
--   • quote_approvals — the maker-checker audit row for a floor-breaching quote (pending→approved|rejected).
-- The two NEW tenant tables get a leading (tenant_id, …) index and the CANONICAL 0232-form tenant_isolation
-- RLS policy (re-applied via the generic DO-loop below) + app_user grants. Additive & idempotent; runs on
-- PGlite + Postgres alike.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS unit_cost numeric(14,2) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS discount_pct numeric(6,3) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS margin_pct numeric(6,3);
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS requires_approval boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS approved_by text;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS approved_at timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cpq_settings (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  min_margin_pct numeric(6,3) NOT NULL DEFAULT 20,
  max_discount_pct numeric(6,3) NOT NULL DEFAULT 15,
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_cpq_settings_tenant ON cpq_settings (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS quote_approvals (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  quote_id bigint NOT NULL REFERENCES quotes(id),
  requested_by text,
  approved_by text,
  status text NOT NULL DEFAULT 'pending',
  reason text,
  min_margin_pct numeric(6,3),
  max_discount_pct numeric(6,3),
  margin_pct numeric(6,3),
  discount_pct numeric(6,3),
  created_at timestamptz DEFAULT now(),
  decided_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_quote_appr_quote ON quote_approvals (tenant_id, quote_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_quote_appr_status ON quote_approvals (tenant_id, status);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the two new
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

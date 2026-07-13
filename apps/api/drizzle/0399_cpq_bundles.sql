-- 0399_cpq_bundles — CRM-14 (CPQ guided selling: bundles + tiered discount-approval matrix, control CRM-12).
-- Deepens the existing CPQ-01 spine (SVC-1, migration 0328) — extend, don't duplicate:
--   • cpq_bundles / cpq_bundle_items — a bundle SKU priced as the discounted sum of its component product
--     configs. A bundle expands into ordinary quote_lines (tagged bundle_code) on add, so the EXISTING
--     CPQ-01 metricsFromLines()/sendQuote() floor check automatically covers a bundle's blended margin —
--     no core service change, a bundle cannot be used to hide margin erosion.
--   • cpq_settings.exec_discount_pct — a second, higher discount threshold: a breach above the existing
--     max_discount_pct (rep/manager-approvable) but at/under this new ceiling still routes to any cpq_approve
--     holder (manager tier, unchanged behaviour); a breach ABOVE it requires a caller holding `exec`
--     specifically (a tiered discount-approval matrix, not a single flat floor). quote_approvals.required_tier
--     records which tier applied (manager|exec) for the ToE.
-- No new maker-checker rail — extends the CPQ-01 one. Tenant-scoped (0232 RLS). Migration number buffered
-- ahead of the concurrently-hot sequence.
--
-- ⚠️ §0 below re-creates 0328's objects FIRST (verbatim, all idempotent): 0328_cpq_discount_approval was
-- journaled with `when`=…293 while prod had already applied past that point, so prod SILENTLY SKIPPED it
-- forever (the 0145/0146 class — drizzle only applies entries with `when` greater than the last applied).
-- First prod deploy of this file therefore failed 42P01 `relation "cpq_settings" does not exist` while
-- fresh-DB CI stayed green (fresh DBs apply 0328 normally; every statement here is IF-NOT-EXISTS-safe for
-- them). This file had never been applied in prod, so editing it in place is safe.

-- ── §0. Re-create the silently-skipped 0328 objects (idempotent) ─────────────────────────────────────
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

-- ── §1. CRM-14 proper ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cpq_bundles (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_cpq_bundle_code ON cpq_bundles (tenant_id, code);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS cpq_bundle_items (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  bundle_id bigint NOT NULL REFERENCES cpq_bundles(id),
  config_id bigint NOT NULL REFERENCES product_configs(id),
  qty numeric(10,2) NOT NULL DEFAULT '1',
  unit_cost numeric(14,2) NOT NULL DEFAULT '0',  -- component COGS, captured so the bundle's blended margin is checkable
  sequence integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cpq_bundle_item_bundle ON cpq_bundle_items (tenant_id, bundle_id);
--> statement-breakpoint

ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS bundle_code text;  -- tags lines expanded from a bundle instance
--> statement-breakpoint
ALTER TABLE cpq_settings ADD COLUMN IF NOT EXISTS exec_discount_pct numeric(6,3);  -- tier-2 threshold; null = tiering off (manager tier only, unchanged)
--> statement-breakpoint
ALTER TABLE quote_approvals ADD COLUMN IF NOT EXISTS required_tier text;  -- manager | exec
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) for the two new
-- tables. Idempotent; runs on PGlite + Postgres alike.
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

-- 0314_ap_dynamic_discount — Dynamic / early-payment discounting on the AP payment run (FIN-9, control EXP-14).
-- Extends the FIN-2 AP payment run (0296/0297, EXP-13) with a maker-checked sliding-scale prompt-payment
-- discount policy (ap_discount_terms — per-vendor or global). When a run pays an approved bill early, the
-- discount is captured as income (Cr 4600 Early-Payment Discount Income) and the cash disbursed is reduced.
-- Adds the discount-income GL account, the run/line discount summary columns, and the policy table (tenant-
-- scoped, RLS + the canonical 0232 org-sharing tenant_isolation policy).
INSERT INTO accounts (code, name, type)
  VALUES ('4600', 'Early-Payment Discount Income', 'Revenue')
  ON CONFLICT (code) DO NOTHING;
--> statement-breakpoint
ALTER TABLE ap_payment_runs ADD COLUMN IF NOT EXISTS total_discount numeric(14,2) DEFAULT 0;
--> statement-breakpoint
ALTER TABLE ap_payment_run_lines ADD COLUMN IF NOT EXISTS days_early integer;
--> statement-breakpoint
ALTER TABLE ap_payment_run_lines ADD COLUMN IF NOT EXISTS discount_rate numeric(6,4);
--> statement-breakpoint
ALTER TABLE ap_payment_run_lines ADD COLUMN IF NOT EXISTS discount_amount numeric(14,2);
--> statement-breakpoint
ALTER TABLE ap_payment_run_lines ADD COLUMN IF NOT EXISTS discount_account text;
--> statement-breakpoint
ALTER TABLE ap_payment_run_lines ADD COLUMN IF NOT EXISTS discount_policy_id bigint;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ap_discount_terms (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  vendor_id bigint,
  name text NOT NULL,
  discount_pct numeric(6,4) NOT NULL,
  min_days_early integer NOT NULL DEFAULT 1,
  full_discount_days integer NOT NULL DEFAULT 20,
  prorate boolean NOT NULL DEFAULT true,
  discount_account text NOT NULL DEFAULT '4600',
  active_from date,
  active_to date,
  status text NOT NULL DEFAULT 'Draft',
  created_by text,
  created_at timestamptz DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  reject_reason text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ap_discount_terms_scope ON ap_discount_terms (tenant_id, status, vendor_id);
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

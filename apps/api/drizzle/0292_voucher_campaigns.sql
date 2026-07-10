-- 0292_voucher_campaigns — POS-3 (docs/41): standalone campaign voucher/coupon codes redeemable at checkout.
-- voucher_campaigns: the discount spec (percent | amount, mirroring the promo/pricing shapes), validity
-- window, min-spend / channel gates, per-code use policy (1 = single-use) and an optional campaign-wide
-- redemption cap. Activation is maker-checker (REV-20): created 'PendingApproval' (checkout redeems only
-- 'Active' campaigns), approved by a DIFFERENT user. voucher_codes: crypto-random codes, unique per tenant,
-- one-way state (issued → redeemed | void) with redeemed_at/by/sale_ref + use_count for the redemption audit.
-- Both tenant-scoped → RLS (canonical 0232 org-clause form) + tenant-leading indexes + app_user grants.
CREATE TABLE IF NOT EXISTS voucher_campaigns (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  campaign_code text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'percent',
  value numeric(14,2) NOT NULL DEFAULT 0,
  min_spend numeric(14,2),
  channel text DEFAULT 'any',
  valid_from date,
  valid_to date,
  per_code_max_uses integer NOT NULL DEFAULT 1,
  max_redemptions integer,
  status text NOT NULL DEFAULT 'PendingApproval',
  codes_issued integer NOT NULL DEFAULT 0,
  redeemed_count integer NOT NULL DEFAULT 0,
  created_by text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS voucher_campaigns_tenant_code ON voucher_campaigns (tenant_id, campaign_code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS voucher_campaigns_tenant_status ON voucher_campaigns (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS voucher_codes (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  campaign_id bigint NOT NULL REFERENCES voucher_campaigns(id),
  code text NOT NULL,
  state text NOT NULL DEFAULT 'issued',
  use_count integer NOT NULL DEFAULT 0,
  redeemed_at timestamptz,
  redeemed_by text,
  sale_ref text,
  voided_at timestamptz,
  voided_by text,
  void_reason text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS voucher_codes_tenant_code ON voucher_codes (tenant_id, code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS voucher_codes_tenant_campaign ON voucher_codes (tenant_id, campaign_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS voucher_codes_tenant_state ON voucher_codes (tenant_id, state);
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

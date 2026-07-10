-- 0309_pos_tip_adjust — Tip-adjust-after-auth (POS-10). The US-restaurant "authorize now, add the tip,
-- capture later" card flow: a card tender is AUTHORIZED for the bill amount at checkout (status Authorized,
-- no money captured yet), staff then ADJUST the tip the guest wrote on the slip BEFORE capture, and the
-- final capture takes amount + tip. Two controls bound the adjustment: it is pre-capture only (an already
-- captured/settled tender is immutable), and the tip may not exceed a policy % of the authorized amount
-- (default 25%). Every adjustment is written to an immutable audit log (pos_tip_adjustments) so the tip a
-- guest was charged can always be tied back to the slip. On capture the tip posts to 2300 Tips Payable, so
-- the existing tip-pool/distribution flow (TIP-01) pays it out unchanged. Tenant-scoped (RLS + tenant-index).
CREATE TABLE IF NOT EXISTS pos_tip_adjustments (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  payment_no text NOT NULL,
  old_tip numeric(18,4) NOT NULL DEFAULT 0,
  new_tip numeric(18,4) NOT NULL DEFAULT 0,
  delta numeric(18,4) NOT NULL DEFAULT 0,
  auth_amount numeric(18,4) NOT NULL DEFAULT 0,
  max_tip numeric(18,4) NOT NULL DEFAULT 0,
  reason text,
  adjusted_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pos_tip_adjustments_tenant_payment ON pos_tip_adjustments (tenant_id, payment_no);
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

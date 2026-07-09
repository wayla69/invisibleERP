-- 0289_gr_receiving_controls — Blind-count goods receiving controls (EXP-12). (1) goods_receipts.created_at:
-- the precise receipt timestamp that anchors the supplier-claim window (a claim must be opened within N hours
-- of the receipt — default 24 — after which the system refuses it). Backfilled from gr_date for historical
-- rows. (2) receiving_settings: per-tenant receiving tolerances — over_receipt_weight_pct (a weight-UoM PO
-- line may over-receive up to this % of the ordered qty, default 5; every other UoM is hard-capped at the
-- ordered qty) and claim_window_hours (the claim cutoff). Tenant-scoped (RLS + tenant-leading index).
-- (3) gr_claims.created_at for the claim audit trail.
ALTER TABLE goods_receipts ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
--> statement-breakpoint
UPDATE goods_receipts SET created_at = gr_date::timestamptz WHERE gr_date IS NOT NULL AND gr_date < current_date;
--> statement-breakpoint
ALTER TABLE gr_claims ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS receiving_settings (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  over_receipt_weight_pct numeric(6,3) NOT NULL DEFAULT 5,
  claim_window_hours integer NOT NULL DEFAULT 24,
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_receiving_settings_tenant ON receiving_settings (tenant_id);
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

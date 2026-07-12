-- 0358_revrec_billing_schedule — Track D Wave 1 (control REV-24): contract-asset / contract-liability split +
-- independent billing schedule under TFRS 15 / IFRS 15 / ASC 606 §105-107. Billing is DECOUPLED from revenue
-- recognition (REV-19): revenue is recognized as performance obligations are satisfied (revrec_schedules),
-- while invoices are raised on their OWN milestone/period schedule (rev_billing_schedules below). The net
-- position drives the split: recognized > billed ⇒ contract ASSET (1265 unbilled receivable); billed >
-- recognized ⇒ contract LIABILITY (2410 deferred revenue). Billing reclasses the earned contract asset
-- 1265 → 1100 AR and parks any over-billing in 2410. No new COA (1100/1265/2410/4300 already exist).
--
-- 1) rev_contracts gets `billed_amount` — cumulative amount billed to the customer, independent of
--    recognition. Backfilled to total_price for already-activated (Active/Completed) contracts so the
--    REV-19 up-front-billing behaviour is preserved (recognition then releases 2410 as before). Draft
--    contracts stay 0 (activate sets it).
-- 2) rev_billing_schedules — the maker-checker billing milestone table (tenant-scoped, leading
--    (tenant_id, contract_id) index + the CANONICAL 0232-form tenant_isolation RLS policy + app_user grants).

ALTER TABLE rev_contracts ADD COLUMN IF NOT EXISTS billed_amount numeric(18,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE rev_contracts SET billed_amount = total_price WHERE status IN ('Active', 'Completed') AND billed_amount = 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS rev_billing_schedules (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  contract_id bigint NOT NULL REFERENCES rev_contracts(id),
  period text NOT NULL,
  planned_amount numeric(18,4) NOT NULL,
  billed_amount numeric(18,4) NOT NULL DEFAULT 0,
  invoice_ref text,
  status text NOT NULL DEFAULT 'Planned',
  billed_entry_id bigint,
  created_by text,
  billed_by text,
  billed_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rev_billing_sched_tenant ON rev_billing_schedules (tenant_id, contract_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rev_billing_sched_status ON rev_billing_schedules (tenant_id, period, status);
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

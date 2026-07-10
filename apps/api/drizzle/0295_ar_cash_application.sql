-- 0295_ar_cash_application — AR cash application (REV-20, docs/41 FIN-1). (1) ar_receipt_applications:
-- one row per (receipt|credit-note) × invoice application — a single customer receipt can now settle MANY
-- invoices (partial allowed), an Issued AR-linked credit note can be applied as a credit line, an
-- application at/over the approval threshold parks PendingApproval for a DIFFERENT approver, and a
-- reversal is audited (flag + reason + who/when). (2) ar_receipts.unapplied_amount: the on-account
-- (unapplied-cash) state of a receipt — the remainder of a cash-application receipt parks here
-- (GL 2220 Unapplied Customer Receipts) until applied later via apply-on-account. Existing single-invoice
-- receipts stay fully applied (unapplied_amount 0). Tenant-scoped (RLS + tenant-leading indexes).
ALTER TABLE ar_receipts ADD COLUMN IF NOT EXISTS unapplied_amount numeric(14,2) DEFAULT 0;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ar_receipt_applications (
  id bigserial PRIMARY KEY,
  application_no text NOT NULL UNIQUE,
  batch_no text NOT NULL,
  tenant_id bigint REFERENCES tenants(id),
  source_type text NOT NULL DEFAULT 'receipt',
  receipt_no text NOT NULL,
  invoice_no text NOT NULL,
  applied_amount numeric(14,2) NOT NULL,
  status text NOT NULL DEFAULT 'applied',
  applied_by text,
  applied_at timestamptz DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  reject_reason text,
  reversed boolean NOT NULL DEFAULT false,
  reversed_by text,
  reversed_at timestamptz,
  reverse_reason text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_apply_invoice ON ar_receipt_applications (tenant_id, invoice_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_apply_receipt ON ar_receipt_applications (tenant_id, receipt_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_apply_batch ON ar_receipt_applications (tenant_id, batch_no);
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

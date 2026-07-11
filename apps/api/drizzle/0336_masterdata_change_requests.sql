-- 0336_masterdata_change_requests — GRC-3: sensitive single-record master-data maker-checker (MDM-01).
-- Maker-checker on master data covered only BULK imports (masterdata_import_batches, G5/G7/G8) and a
-- vendor's bank_name/bank_account (0270, vendor_bank_change_requests). A NORMAL single-record UI/CRUD edit of
-- a SENSITIVE vendor field — its credit limit, its payment terms, or the payee account-holder name — still
-- wrote the master directly with no second check. Redirecting a supplier's payee details is the classic
-- disbursement-fraud / BEC vector. This adds:
--   • vendors.bank_account_name — the payee account-holder name the payment file must match (plaintext text;
--     nullable). Sensitive like bank_name/bank_account: routed through the change maker-checker below.
--   • masterdata_change_requests — a GENERIC staged-change queue (entity_type vendor|customer|item, a field
--     key, and the before/after value). A sensitive-field edit is staged `pending` and applied to the entity
--     ONLY when a DISTINCT user approves it (approved_by ≠ requested_by → 403 SOD_SELF_APPROVAL); reject
--     discards it (master untouched). old_value/new_value are text-typed but written via the app's
--     encryptedText column type (AES-256-GCM at rest) — a staged bank value must not sit in plaintext.
-- Tenant-scoped: a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation RLS policy
-- (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS bank_account_name text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS masterdata_change_requests (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  req_no text NOT NULL,
  entity_type text NOT NULL,
  entity_id bigint NOT NULL,
  field text NOT NULL,
  old_value text,
  new_value text,
  status text NOT NULL DEFAULT 'pending',
  reason text,
  requested_by text,
  requested_at timestamptz DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  reject_reason text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_masterdata_change_no ON masterdata_change_requests (req_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_masterdata_change_tenant ON masterdata_change_requests (tenant_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_masterdata_change_entity ON masterdata_change_requests (entity_type, entity_id);
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

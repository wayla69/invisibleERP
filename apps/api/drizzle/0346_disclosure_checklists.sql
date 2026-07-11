-- 0346_disclosure_checklists — CLS-02 (control GL-26): Disclosure / close-package checklist (governed close binder).
-- SEC disclosure-controls expectation: a statutory-FS *report* exists (reports/statutory-fs) but there is no
-- governed checklist producing the reporting package. This adds a per-period disclosure binder: a preparer
-- opens a checklist for a period (auto-seeded with the standard TFRS/SEC disclosure items — each with an owner,
-- a standard reference and an Open/Complete/NA status + optional support-doc evidence via doc_attachments docType
-- DISC), completes/NAs every item, and a DISTINCT reviewer (reviewer ≠ preparer → 403 SOD_SELF_APPROVAL) reviews
-- the binder — which is blocked while any item is still Open (ITEMS_INCOMPLETE) — before the financials are Issued.
-- Detective/monitoring; posts NOTHING to the GL. Two tenant-scoped tables:
--   • disclosure_checklists — header (period, status Draft/Reviewed/Issued, prepared_by, reviewed_by, issued_by)
--   • disclosure_items — per item (item, standard_ref, owner, status Open/Complete/NA, support_doc_ref, completed_by)
-- Each gets a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation RLS policy (re-applied via
-- the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS disclosure_checklists (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  checklist_no text NOT NULL,
  period text NOT NULL,
  title text,
  status text NOT NULL DEFAULT 'Draft',
  prepared_by text,
  prepared_at timestamptz DEFAULT now(),
  reviewed_by text,
  reviewed_at timestamptz,
  issued_by text,
  issued_at timestamptz,
  note text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_disclosure_checklists_no ON disclosure_checklists (checklist_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_disclosure_checklists_tenant ON disclosure_checklists (tenant_id, period);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS disclosure_items (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  checklist_id bigint NOT NULL REFERENCES disclosure_checklists(id),
  seq integer NOT NULL,
  item text NOT NULL,
  standard_ref text,
  owner text,
  status text NOT NULL DEFAULT 'Open',
  support_doc_ref text,
  completed_by text,
  completed_at timestamptz,
  notes text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_disclosure_items_tenant ON disclosure_items (tenant_id, checklist_id);
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

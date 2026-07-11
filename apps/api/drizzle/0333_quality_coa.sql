-- 0333_quality_coa — QMS-3 (QMS audit): Certificate of Analysis (CoA) capture + out-of-spec release approval.
-- Lots exist (lot_ledger, read-only, with a Quarantine status value never written) but there is no concept of
-- a quality spec / measured characteristic / Certificate of Analysis, and no gate on releasing an out-of-spec
-- lot. This adds, ALONGSIDE the read-only lot ledger (which is NOT rewritten — CoA references a lot_no text):
--   • quality_specs — per item: an acceptable [min_value, max_value] range for a measured characteristic.
--   • coa_certificates — a CoA against a lot (source incoming/production). overall_result is computed on
--     evaluate (fail = any characteristic actual outside its [min,max]). A pass CoA can be released by its
--     recorder; a FAIL (out-of-spec) CoA can be released ONLY by a DIFFERENT user WITH a mandatory
--     deviation_reason (QC-03 maker-checker: released_by ≠ created_by → SOD_SELF_APPROVAL) — the documented
--     deviation approval. Reject sets release_status='rejected'.
--   • coa_results — child measured results (spec window snapshot + actual + pass/fail per characteristic).
-- Each new table is tenant-scoped: a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation
-- RLS policy (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS quality_specs (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  spec_no text NOT NULL,
  item_id text NOT NULL,
  characteristic text NOT NULL,
  uom text,
  min_value numeric(18,4),
  max_value numeric(18,4),
  target_value numeric(18,4),
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_quality_specs_tenant ON quality_specs (tenant_id, item_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_quality_specs_no ON quality_specs (tenant_id, spec_no);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS coa_certificates (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  coa_no text NOT NULL,
  lot_no text NOT NULL,
  item_id text NOT NULL,
  source text NOT NULL DEFAULT 'incoming', -- incoming | production
  overall_result text NOT NULL DEFAULT 'pending', -- pass | fail | pending
  released boolean NOT NULL DEFAULT false,
  release_status text NOT NULL DEFAULT 'held', -- held | released | rejected
  released_by text,
  deviation_reason text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  decided_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_coa_certificates_tenant ON coa_certificates (tenant_id, release_status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_coa_certificates_lot ON coa_certificates (lot_no);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_coa_certificates_no ON coa_certificates (tenant_id, coa_no);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS coa_results (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  coa_id bigint NOT NULL REFERENCES coa_certificates(id),
  characteristic text NOT NULL,
  uom text,
  spec_min numeric(18,4),
  spec_max numeric(18,4),
  actual_value numeric(18,4),
  result text NOT NULL DEFAULT 'pass' -- pass | fail
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_coa_results_tenant ON coa_results (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_coa_results_coa ON coa_results (coa_id);
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

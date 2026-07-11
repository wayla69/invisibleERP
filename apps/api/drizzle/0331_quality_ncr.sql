-- 0331_quality_ncr — QMS-1 (QC-01): Non-Conformance (NCR) register with maker-checker disposition.
-- The only quality surface today (quality_inspections / /api/quality) lets an inspector self-disposition a
-- failed inspection, and a Scrap disposition posts a GL write-off (Dr 5810 / Cr inventory) with NO approval.
-- This adds a first-class NCR register where a financial disposition (scrap / use_as_is / return) is proposed
-- as `pending_disposition` and applied — and any write-off posted — ONLY when a DIFFERENT user approves
-- (dispositioned_by ≠ raised_by → 403 SOD_SELF_APPROVAL, QC-01). It does NOT change the existing
-- quality_inspections path (a failed inspection may be *promoted* into an NCR, but /inspect is untouched).
--   • defect_codes       — a small per-tenant reason lookup for NCRs.
--   • non_conformances   — the NCR register (open → pending_disposition → dispositioned → closed).
-- Each new table is tenant-scoped: a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation
-- RLS policy (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS defect_codes (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,
  name text,
  category text,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_defect_codes_tenant ON defect_codes (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_defect_codes_tenant_code ON defect_codes (tenant_id, code);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS non_conformances (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  ncr_no text NOT NULL,
  source text NOT NULL DEFAULT 'in_process', -- incoming | in_process | customer | supplier
  ref_type text,
  ref_doc text,
  item_id text,
  item_description text,
  defect_code text,
  severity text NOT NULL DEFAULT 'minor', -- minor | major | critical
  qty numeric(14,3) DEFAULT '0',
  unit_cost numeric(16,4) DEFAULT '0',
  description text,
  proposed_disposition text, -- scrap | use_as_is | return | rework
  status text NOT NULL DEFAULT 'open', -- open | pending_disposition | dispositioned | closed
  write_off_value numeric(16,2) DEFAULT '0',
  entry_no text,
  raised_by text,
  dispositioned_by text,
  disposition_notes text,
  created_at timestamptz DEFAULT now(),
  decided_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_non_conformances_tenant ON non_conformances (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_non_conformances_tenant_no ON non_conformances (tenant_id, ncr_no);
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

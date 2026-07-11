-- 0334_supplier_scar — QMS-4: Supplier Corrective Action Request (SCAR / 8D) register (control QC-04).
-- Supplier defects are captured (gr_claims) and supplier performance is scored (supplier_scorecards via
-- procurement.service.ts recomputeScorecard), but there is NO formal corrective-action request issued to a
-- vendor with response tracking and a closure gate before requalification. This adds, ALONGSIDE those paths
-- (no change to gr_claims / supplier_scorecards / the scorecard computation):
--   • supplier_scars — a formal 8D/SCAR sourced from a gr_claim + vendor. Lifecycle open →
--     supplier_responded → pending_closure → closed | rejected. QC-04 closure gate: a SCAR is closed ONLY by
--     a DIFFERENT user than the raiser (closed_by ≠ raised_by → SOD_SELF_APPROVAL) and only after the
--     supplier has responded AND the 8D root_cause + corrective_action are populated (SCAR_INCOMPLETE),
--     recording an effectiveness verdict. Detective read: open SCARs past due (the overdue worklist).
-- Tenant-scoped: a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation RLS policy
-- (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS supplier_scars (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  scar_no text NOT NULL,
  vendor_id bigint REFERENCES vendors(id),
  source_claim_no text,
  defect_summary text NOT NULL,
  severity text NOT NULL DEFAULT 'major',
  containment text,
  root_cause text,
  corrective_action text,
  preventive_action text,
  status text NOT NULL DEFAULT 'open',
  effectiveness text,
  due_date date,
  raised_by text,
  supplier_responded_by text,
  supplier_responded_at timestamptz,
  closed_by text,
  closed_at timestamptz,
  reject_reason text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_supplier_scars_tenant ON supplier_scars (tenant_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_supplier_scars_vendor ON supplier_scars (vendor_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_scars_no ON supplier_scars (tenant_id, scar_no);
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

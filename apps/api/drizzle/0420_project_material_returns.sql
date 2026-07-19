-- 0420_project_material_returns — material return-to-stock (docs/50 Wave 2 A1; new control INV-19).
-- The docs/32 material loop controls acquisition (budget → commit → reserve → issue-to-WIP) but has NO
-- governed inverse: unused site material could only re-enter stock as an ad-hoc adjustment outside the
-- control. A return request references the CONSUMED reservation it reverses (qty ≤ issued, aggregate per
-- reservation; reason mandatory), values at the ORIGINAL issue unit cost, and — at/above the materiality
-- threshold — posts nothing until a DIFFERENT user approves (maker-checker, SoD; the docs/49 seam applies).
-- Posting: stock back on hand (Dr 1200-set) / project WIP relieved (Cr 1260, project_id dimension) via the
-- valued sub-ledger + a negative consumed commitment un-draws the BoQ line. One tenant table (0232 RLS).
CREATE TABLE IF NOT EXISTS project_material_returns (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  return_no text NOT NULL UNIQUE,
  reservation_id bigint NOT NULL,
  project_id bigint NOT NULL,
  item_id text NOT NULL,
  location_id text NOT NULL,
  qty numeric(18,4) NOT NULL,
  unit_cost numeric(18,4) NOT NULL,
  value numeric(18,2) NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'PendingApproval', -- PendingApproval | Posted | Rejected
  requested_by text,
  approved_by text,
  approved_at timestamptz,
  move_no text,
  gl_entry_no text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_material_returns_tenant ON project_material_returns (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_project_material_returns_res ON project_material_returns (reservation_id);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
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

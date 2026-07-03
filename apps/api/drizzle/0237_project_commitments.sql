-- 0237_project_commitments — Project material control M1 (docs/32, PROJ-12). The commitment/encumbrance
-- ledger that makes the BoQ-line material budget ENFORCED, not just observed: each row reserves part of a
-- BoQ line's budget for a source document (a project PO today). `open`+`consumed` count against the line
-- budget; `released` frees it. A new draw is checked atomically under a FOR UPDATE row-lock on the BoQ line
-- (in the service) so two concurrent draws can't jointly overrun. Tenant-scoped (RLS via the canonical loop).
CREATE TABLE IF NOT EXISTS project_commitments (
  id bigserial PRIMARY KEY,
  project_id bigint NOT NULL REFERENCES projects(id),
  boq_line_id bigint NOT NULL REFERENCES project_boq_lines(id),
  tenant_id bigint REFERENCES tenants(id),
  source_doc_type text NOT NULL,                    -- PO | PMR | PR | ADV | REIMB
  source_doc_no text NOT NULL,
  qty numeric(18,4) NOT NULL DEFAULT 0,
  amount numeric(16,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',              -- open | consumed | released
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_commit_boq_line ON project_commitments (boq_line_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_commit_project ON project_commitments (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_commit_source ON project_commitments (source_doc_type, source_doc_no);
--> statement-breakpoint
-- app_user grants for the new table + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form)
-- so project_commitments gets RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

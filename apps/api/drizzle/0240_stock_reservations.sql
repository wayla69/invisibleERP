-- 0240_stock_reservations — Project material control M3 (docs/32, INV-13). Soft allocation of on-hand stock
-- to a project: available-to-issue = on_hand − Σ(held reservations), so the same stock can't be double-
-- allocated. A reservation is held → released (freed) or consumed (issued to the project, value moving from
-- inventory 1200 to project WIP 1260). Tenant-scoped (RLS + tenant-leading index).
CREATE TABLE IF NOT EXISTS stock_reservations (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  item_id text NOT NULL,
  location_id text NOT NULL DEFAULT 'WH-MAIN',
  project_id bigint NOT NULL,
  boq_line_id bigint,
  source_doc_type text NOT NULL DEFAULT 'RES',   -- RES | PMR
  source_doc_no text,
  qty_reserved numeric(18,4) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'held',           -- held | released | consumed
  issue_no text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stock_res_item ON stock_reservations (tenant_id, item_id, location_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stock_res_project ON stock_reservations (project_id);
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

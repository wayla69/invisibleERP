-- 0436_service_requests — diner "call staff" / service requests (QR → floor & KDS).
-- A diner taps เรียกพนักงาน / ขอน้ำ / ขอช้อนส้อม / ขอบิล on the QR page; a row is raised here and pushed to
-- the floor board (realtime) for staff to acknowledge and clear. Tenant-scoped (canonical 0232 RLS + a
-- tenant-leading index for the AUD-ARC-01 gate).
CREATE TABLE IF NOT EXISTS service_requests (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  session_id bigint REFERENCES table_sessions(id),
  table_id bigint REFERENCES dining_tables(id),
  type text NOT NULL,                       -- waiter | water | cutlery | bill | custom
  note text,
  status text NOT NULL DEFAULT 'open',      -- open | ack | done
  created_by text,
  created_at timestamptz DEFAULT now(),
  acked_by text,
  acked_at timestamptz,
  done_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_service_requests_tenant ON service_requests (tenant_id, status, created_at);
--> statement-breakpoint
-- app_user grants + the CANONICAL org-scoped tenant_isolation policy (0232 form) for the new tenant table.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name='service_requests' LOOP
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

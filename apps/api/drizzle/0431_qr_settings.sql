-- 0431_qr_settings — SOX-ICFR audit #3 (public QR ordering abuse). Per-tenant control over whether an
-- anonymous QR order auto-fires straight to the kitchen. When `require_staff_fire` is on, a diner's QR order
-- is created but PARKED (not fired) until floor staff release it — so an injected/spam order becomes a queue
-- nuisance a human clears, not an unbounded inventory/GL event. Default OFF ⇒ existing auto-fire behaviour.
-- Tenant-scoped (PK is the leading (tenant_id) index the AUD-ARC-01 gate wants); RLS applied via the loop.
CREATE TABLE IF NOT EXISTS qr_settings (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id),
  require_staff_fire boolean NOT NULL DEFAULT false,
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
-- app_user grants + the CANONICAL org-scoped tenant_isolation policy (0232 form) for the new tenant table.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name='qr_settings' LOOP
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

-- 0424_je_exceptions — B5 (docs/50 Wave 5, control GL-28): JE anomaly & control-exception analytics.
-- A rule-based DETECTIVE register over journal_entries/journal_lines/gl_audit_log: duplicate JEs,
-- round-amount manual entries, backdated posting, after-hours posting (Asia/Bangkok), and unusual
-- cash↔revenue manual pairs. The scan is idempotent (one open/dismissed row per tenant × rule × entry —
-- NULL-tenant rows are deduped via the coalesce unique index); dismissing an exception requires a reason
-- and writes a gl_audit_log EXCEPTION_DISMISSED row (the GL-28 review evidence). One tenant table
-- (0232 canonical RLS).
CREATE TABLE IF NOT EXISTS je_exceptions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  rule_key text NOT NULL,
  entry_id bigint NOT NULL,
  entry_no text,
  severity text NOT NULL DEFAULT 'medium',
  detail jsonb,
  status text NOT NULL DEFAULT 'open',
  dismissed_by text,
  dismissed_at timestamptz,
  dismiss_reason text,
  detected_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_je_exceptions ON je_exceptions (coalesce(tenant_id, 0), rule_key, entry_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_je_exceptions_tenant ON je_exceptions (tenant_id, status);
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

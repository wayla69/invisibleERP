-- 0386_audience_export_members — depth follow-up to G3 (docs/45, extends PDPA-05): consent-WITHDRAWAL
-- removal sync. Problem: the audience export was additive-only — a member who withdrew marketing consent
-- was excluded from the NEXT upload but never REMOVED from the audience already sitting at Meta/Google,
-- so the external audience drifted out of step with the consent ledger. Fix:
--   • audience_export_members — the upload MANIFEST: which member hashes are currently out there
--     (hash-only + member_id; PDPA minimization unchanged). Captured at upload time, so removal still
--     works after a DSAR erasure nulls the member's phone/email (the hashes were recorded when lawful).
--   • audience_exports.rows_removed — per-run removal count on the existing register (audit evidence).
-- Every audience_export_sync run now prunes: manifest members with NO live marketing consent are pushed
-- as REMOVE operations (Meta DELETE /users; Google OfflineUserDataJob remove ops) and stamped removed_at.
-- Idempotent: a removed manifest row is never a removal candidate again unless re-uploaded after re-consent.
CREATE TABLE IF NOT EXISTS audience_export_members (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  member_id bigint NOT NULL,               -- pos_members soft FK
  hashed_email text,
  hashed_phone text,                       -- Meta variant (E.164 digits, no '+')
  hashed_phone_plus text,                  -- Google variant ('+'-prefixed before hashing)
  last_pushed_at timestamptz,
  removed_at timestamptz,                  -- set when the REMOVE was pushed to every configured target
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_audience_export_members ON audience_export_members (tenant_id, member_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audience_export_members_tenant ON audience_export_members (tenant_id, removed_at);
--> statement-breakpoint
ALTER TABLE audience_exports ADD COLUMN IF NOT EXISTS rows_removed bigint NOT NULL DEFAULT 0;
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

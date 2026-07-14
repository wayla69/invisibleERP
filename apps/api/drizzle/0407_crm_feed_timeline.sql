-- 0407_crm_feed_timeline — CRM-8 unified timeline + collaboration feed (control CRM-14).
-- crm_feed_posts is an APPEND-ONLY internal note on a lead / opportunity / account (no updated_at, no edit/
-- delete path) — the collaboration + decision trail on the customer record cannot be silently rewritten.
-- `mentions` is the set of @-mentioned usernames validated at post time; each is routed a DIRECTED
-- notification via the new notifications.target_username column (visible only to that user within the tenant).
-- Feed posts surface in the unified timeline (GET /api/crm/timeline). One tenant table (0232 RLS) + one
-- backward-compatible column on the platform-level notifications table.

CREATE TABLE IF NOT EXISTS crm_feed_posts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  entity_type text NOT NULL,                     -- lead | opportunity | account
  entity_no text NOT NULL,                        -- lead_no | opp_no | account_no
  body text NOT NULL,
  mentions jsonb NOT NULL DEFAULT '[]',           -- string[] of validated @-mentioned usernames
  author text,                                    -- posting username
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_feed_post_entity ON crm_feed_posts (tenant_id, entity_type, entity_no);
--> statement-breakpoint

-- Directed-notification target (CRM-8 @mentions). Backward compatible: every existing producer leaves it NULL
-- (unchanged role/broadcast behavior); a non-NULL value scopes the row to exactly that user within its tenant.
-- notifications is a platform-level table (target_tenant_id, no tenant_id) so no RLS clause is needed here.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS target_username text;
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

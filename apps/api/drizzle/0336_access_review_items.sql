-- 0336_access_review_items — GRC-2 (ITGC-AC-21): line-item Access Recertification Campaign with
-- closed-loop revocation. The existing UAR (access_reviews) is a BLANKET period sign-off (one row + counts);
-- per-user keep/revoke lived only as blank columns in an offline CSV, with no in-app disposition and no
-- auto-revoke. This promotes it to a first-class recertification campaign:
--   • access_reviews gains campaign columns — status (certified | open | in_review), items_total,
--     items_revoked. Existing/blanket rows default to 'certified' (they ARE certified); a campaign is opened
--     as 'open', drifts to 'in_review', and is finalized 'certified'.
--   • access_review_items — one row per user in a campaign. The reviewer keeps/revokes each user IN-APP
--     (decision pending → keep | revoke); on certification (admin-users.service certifyCampaign) every
--     'revoke' decision ACTUALLY removes the user's user_permissions grants and is stamped actioned=true —
--     the closed loop auditors expect for ITGC-AC-08. current_perms snapshots the effective permissions at
--     open time (the recertification evidence).
-- The new table is tenant-scoped: a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation
-- RLS policy (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
ALTER TABLE access_reviews ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'certified';
--> statement-breakpoint
ALTER TABLE access_reviews ADD COLUMN IF NOT EXISTS items_total integer;
--> statement-breakpoint
ALTER TABLE access_reviews ADD COLUMN IF NOT EXISTS items_revoked integer;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS access_review_items (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  review_id bigint NOT NULL REFERENCES access_reviews(id),
  username text NOT NULL,
  role text,
  current_perms text,
  decision text NOT NULL DEFAULT 'pending', -- pending | keep | revoke
  reviewer text,
  decided_at timestamptz,
  actioned boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_access_review_items_tenant ON access_review_items (tenant_id, review_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_review_items_review_user ON access_review_items (tenant_id, review_id, username);
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

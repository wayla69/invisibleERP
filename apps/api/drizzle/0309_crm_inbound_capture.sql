-- 0309_crm_inbound_capture — CRM-6 (docs/41 CRM-4 note): inbound email capture → CRM (2-way comms).
-- The deferred inbound reply-capture side of CRM-4's outbound deal comms. Mirrors email-capture's AP rail:
-- a per-tenant CRM inbound address receives replies; each inbound is matched to an open opportunity/lead
-- (by reply-threading token embedded in the outbound send, else the sender's contact/lead email) and logged
-- as a timeline activity; unmatched inbound is parked in a review queue.
--  (1) crm_activities.thread_token — deterministic reply-threading token stamped on a CRM-4 outbound activity
--      and embedded in the sent email; an inbound reply carrying it threads back to the originating entity.
--  (2) crm_inbound_messages — the capture log + review queue: every inbound email (matched or not), the
--      provider-redelivery dedupe anchor (message_id), and the authenticity/audit record.
ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS thread_token text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_activity_thread ON crm_activities (tenant_id, thread_token);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS crm_inbound_messages (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  message_id text,                                   -- provider Message-ID (dedupe key)
  from_addr text NOT NULL,                           -- normalised sender address
  subject text,
  body_preview text,                                 -- first ~2000 chars of the plain-text body
  thread_token text,                                 -- token parsed from the reply (subject/body/headers), if any
  match_status text NOT NULL DEFAULT 'unmatched',    -- matched | unmatched
  matched_by text,                                   -- thread_token | contact_email | lead_email | manual
  matched_entity_type text,                          -- opportunity | lead
  matched_entity_no text,
  matched_contact_id bigint,
  activity_id bigint,                                -- the crm_activities row logged on a match
  review_reason text,                                -- why it landed in the queue (e.g. no_match)
  resolved boolean NOT NULL DEFAULT false,           -- review-queue triage: true once linked or dismissed
  resolved_by text,
  resolved_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_inbound_queue ON crm_inbound_messages (tenant_id, match_status, resolved);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_inbound_msg ON crm_inbound_messages (tenant_id, message_id);
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

-- 0348_service_cases — SVC-4 (Service Cloud): Support Cases + Email-to-Case (SVC-04 control). Net-new customer-
-- service foundation, ALONGSIDE the existing #666 subscription/SLA spine and the SVC-2 warranty registry (no
-- change to those paths). Two new tenant-scoped tables:
--   • service_cases        — a support case with a governed status lifecycle (new → open → pending → resolved →
--                            closed, reopen → open), priority P1..P4, owner/assignee, optional CRM contact link,
--                            and a stable email thread_token so customer replies thread back onto the case.
--   • case_email_messages  — the append-only inbound/outbound email trail of a case, deduped per tenant on the
--                            provider Message-ID.
-- Email-to-Case: a @Public @NoTx HMAC webhook (mirrors crm/inbound) posts a parsed customer email; a reply with
-- the case thread token threads onto the case, else the sender matches an OPEN case by contact, else a NEW case
-- is opened — so no inbound customer email is dropped. No GL post in v1.
-- Each new table gets a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation RLS policy
-- (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS service_cases (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  case_no text NOT NULL,
  subject text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'new', -- new | open | pending | resolved | closed
  priority text NOT NULL DEFAULT 'P3', -- P1 | P2 | P3 | P4
  source text NOT NULL DEFAULT 'manual', -- email | manual | phone
  contact_id bigint,
  contact_email text,
  account_id bigint,
  customer_name text,
  assignee text,
  thread_token text,
  opened_at timestamptz DEFAULT now(),
  resolved_at timestamptz,
  closed_at timestamptz,
  resolution_note text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_service_cases_tenant ON service_cases (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_cases_no ON service_cases (tenant_id, case_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_service_cases_token ON service_cases (tenant_id, thread_token);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_service_cases_contact ON service_cases (tenant_id, contact_email);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS case_email_messages (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  case_id bigint REFERENCES service_cases(id),
  direction text NOT NULL DEFAULT 'inbound', -- inbound | outbound
  from_addr text,
  to_addr text,
  subject text,
  body_preview text,
  message_id text,
  thread_token text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_case_email_messages_tenant ON case_email_messages (tenant_id, case_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_case_email_messages_msgid ON case_email_messages (tenant_id, message_id);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new tables
-- get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

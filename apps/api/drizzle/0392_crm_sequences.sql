-- 0392_crm_sequences — CRM-8 (sales sequences / cadences, control CRM-11).
-- Multi-step outreach playbooks on the REV-17 CRM spine + the CRM-6 comms rail (MessagingService). A
-- SEQUENCE is an ordered list of STEPS (channel + wait_days + subject/body); a lead or opportunity is
-- ENROLLED and the due-runner advances each enrolment on cadence, sending the due step and logging it as an
-- auditable crm_activities entry — so a nurtured lead/deal never silently drops out of the cadence. Three
-- tenant tables (0232 RLS). Migration number buffered ahead of the concurrently-hot sequence.

CREATE TABLE IF NOT EXISTS crm_sequences (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  code text NOT NULL,                          -- SEQ-NNNN
  name text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_seq_code ON crm_sequences (tenant_id, code);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS crm_sequence_steps (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  sequence_id bigint NOT NULL REFERENCES crm_sequences(id),
  step_no integer NOT NULL,                     -- 1..n
  channel text NOT NULL DEFAULT 'email',        -- email | line | sms | task
  wait_days integer NOT NULL DEFAULT 0,         -- delay before this step (from enrolment / prior step)
  subject text,
  body text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_seq_step ON crm_sequence_steps (tenant_id, sequence_id, step_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_seq_step_seq ON crm_sequence_steps (tenant_id, sequence_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS crm_sequence_enrollments (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  sequence_id bigint NOT NULL REFERENCES crm_sequences(id),
  entity_type text NOT NULL,                    -- lead | opportunity
  entity_no text NOT NULL,                      -- lead_no | opp_no
  current_step integer NOT NULL DEFAULT 0,      -- 0 = enrolled, not yet started
  status text NOT NULL DEFAULT 'active',        -- active | completed | stopped
  next_due_at timestamptz,                      -- when the next step is due
  enrolled_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_seq_enrol ON crm_sequence_enrollments (tenant_id, sequence_id, entity_type, entity_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_seq_enrol_due ON crm_sequence_enrollments (tenant_id, status, next_due_at);
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

-- 0073 — CRM messaging: member birthday + marketing consent, and a message-delivery log.
-- Columns on pos_members (existing RLS table); message_log is a new tenant-scoped table → RLS loop re-run.
ALTER TABLE pos_members ADD COLUMN IF NOT EXISTS birthday date;
--> statement-breakpoint
ALTER TABLE pos_members ADD COLUMN IF NOT EXISTS marketing_opt_in boolean NOT NULL DEFAULT true;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS message_log (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  member_id bigint REFERENCES pos_members(id),
  channel text NOT NULL,                 -- line | sms | email
  recipient text,                        -- phone / email / line id at send time
  body text NOT NULL,
  campaign text,                         -- optional campaign/label
  status text NOT NULL,                  -- sent | failed | skipped
  provider text,                         -- mock | line | sms | email
  error text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_message_log_tenant ON message_log (tenant_id, created_at);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id table is isolation-scoped.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)', r.table_name);
  END LOOP;
END $$;

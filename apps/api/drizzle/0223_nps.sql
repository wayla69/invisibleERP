-- 0223_nps — docs/27 Phase W3: post-purchase NPS micro-survey (nps_responses). The public answer route is
-- keyed by the single-use random `token` (no PII in the URL); score ≤ 6 fires loyalty.nps_detractor into
-- the automation catalog. One survey per member × sale (idempotent trigger). Tenant-scoped → RLS loop +
-- tenant-leading index (AUD-ARC-01 guard).
CREATE TABLE IF NOT EXISTS nps_responses (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  member_id bigint NOT NULL REFERENCES pos_members(id),
  token text NOT NULL,
  sale_ref text,
  channel text,
  score integer,
  comment text,
  sent_at timestamptz DEFAULT now(),
  responded_at timestamptz,
  expires_at timestamptz,
  created_by text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS nps_responses_token ON nps_responses (token);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS nps_responses_member_sale ON nps_responses (member_id, sale_ref);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS nps_responses_tenant ON nps_responses (tenant_id);
--> statement-breakpoint
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

-- 0228: document attachments (invoice/receipt photos on POs) + LINE chat pending-state
-- doc_attachments: evidence images (supplier invoice / delivery receipt / other) pinned to a document —
-- PO first, doc_type extensible (PR/GR/AP). Stored as data-URLs in-DB (same model as item_images, ~2MB cap
-- enforced in the service). Strengthens 3-way-match documentation (EXP-01 evidence, no control change).
CREATE TABLE IF NOT EXISTS doc_attachments (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  doc_type text NOT NULL,
  doc_no text NOT NULL,
  kind text NOT NULL DEFAULT 'invoice',
  filename text,
  data_url text NOT NULL,
  note text,
  source text NOT NULL DEFAULT 'web',
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_doc_attachments_doc ON doc_attachments (tenant_id, doc_type, doc_no);
--> statement-breakpoint
-- line_chat_states: short-lived per-LINE-user conversation state for multi-step chat flows (first use:
-- `attach <PO no>` → next photo binds to that document). One live state per (tenant, LINE user).
CREATE TABLE IF NOT EXISTS line_chat_states (
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  line_user_id text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (tenant_id, line_user_id)
);
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

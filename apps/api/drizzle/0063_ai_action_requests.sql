-- Phase D1 — agentic write-ops via propose → approve → execute.
-- The AI never mutates ledgers/POs directly; it files a PENDING request here. A DIFFERENT authorized
-- human approves it (SoD: approver ≠ proposer), which then executes through the normal service + GL,
-- fully audited. This table is the human-in-the-loop queue.
CREATE TABLE IF NOT EXISTS ai_action_requests (
  id              bigserial PRIMARY KEY,
  tenant_id       bigint REFERENCES tenants(id),
  kind            text NOT NULL,                 -- journal_entry | purchase_order
  payload         jsonb NOT NULL,                -- the action parameters (validated on execute)
  rationale       text,                          -- the agent's stated reason
  amount          numeric(18,2),                 -- headline amount (for thresholds / display)
  status          text NOT NULL DEFAULT 'pending', -- pending | approved | rejected | executed | failed
  proposed_by     text NOT NULL,                 -- user who ran the agent (identity carried through)
  source          text DEFAULT 'ai',             -- ai | human
  created_at      timestamp DEFAULT now(),
  decided_by      text,                          -- the approver/rejecter (must differ from proposed_by)
  decided_at      timestamp,
  decision_reason text,
  result_ref      text,                          -- e.g. JE-… / PO-… once executed
  error_message   text
);
CREATE INDEX IF NOT EXISTS idx_ai_action_requests_tenant ON ai_action_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ai_action_requests_status ON ai_action_requests(tenant_id, status);
--> statement-breakpoint
-- Re-run the dynamic RLS loop so the new tenant_id table (ai_action_requests) is isolated like every other.
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

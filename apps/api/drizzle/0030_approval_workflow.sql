-- Phase 15 — Generic Approval Workflow engine + Segregation of Duties (SoD). No GL — the engine GATES
-- other modules' postings. RLS via the 0002 DO-block re-run at tail.
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  doc_type text NOT NULL,
  name text NOT NULL,
  active boolean DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wfdef_active ON workflow_definitions (tenant_id, doc_type) WHERE active;

CREATE TABLE IF NOT EXISTS workflow_steps (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  definition_id bigint NOT NULL REFERENCES workflow_definitions(id),
  step_no integer NOT NULL,
  approver_role text,
  approver_user text,
  min_amount numeric(14,2) DEFAULT 0,
  all_of_n integer DEFAULT 1,
  name text,
  CONSTRAINT wfstep_role_xor_user CHECK ((approver_role IS NOT NULL) <> (approver_user IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wfstep_def_no ON workflow_steps (definition_id, step_no);

CREATE TABLE IF NOT EXISTS workflow_instances (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  definition_id bigint REFERENCES workflow_definitions(id),
  doc_type text NOT NULL,
  doc_no text NOT NULL,
  amount numeric(14,2) DEFAULT 0,
  created_by text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  current_step integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  closed_at timestamptz
);
-- idempotency: a given doc has at most ONE live (pending) instance
CREATE UNIQUE INDEX IF NOT EXISTS uq_wfinst_live ON workflow_instances (tenant_id, doc_type, doc_no) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_wfinst_status ON workflow_instances (tenant_id, status);

CREATE TABLE IF NOT EXISTS approval_actions (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  instance_id bigint NOT NULL REFERENCES workflow_instances(id),
  step_no integer NOT NULL,
  actor text NOT NULL,
  on_behalf_of text,
  decision text NOT NULL,
  comment text,
  acted_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appract_instance ON approval_actions (instance_id);
-- append-only guard at the DB level (defence in depth; the service only ever INSERTs)
CREATE OR REPLACE FUNCTION approval_actions_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'approval_actions is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS approval_actions_no_mutate ON approval_actions;
CREATE TRIGGER approval_actions_no_mutate BEFORE UPDATE OR DELETE ON approval_actions
  FOR EACH ROW EXECUTE FUNCTION approval_actions_immutable();

CREATE TABLE IF NOT EXISTS approval_delegations (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  from_user text NOT NULL,
  to_user text NOT NULL,
  from_date date NOT NULL,
  to_date date NOT NULL,
  active boolean DEFAULT true,
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_deleg_to ON approval_delegations (tenant_id, to_user);

CREATE TABLE IF NOT EXISTS sod_rules (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'PERM_PAIR',
  doc_type text,
  perm_a text,
  perm_b text,
  active boolean DEFAULT true
);
CREATE INDEX IF NOT EXISTS idx_sod_tenant ON sod_rules (tenant_id);

-- Re-run the 0002 RLS loop so the new tenant_id tables get tenant_isolation.
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

-- 0150 — CRM sales pipeline (REV-16): leads → opportunities (stage machine) → activities, on the
-- customer-of-record (customer_master, 0149). Closes the structural gap where the CRM was RFM-only with no
-- B2B sales motion. A lead is qualified then CONVERTED (attaching/creating a customer_master + an
-- opportunity); an opportunity moves through a controlled stage machine (won/lost are terminal; lost needs a
-- reason); the weighted pipeline = Σ open-opportunity amount × probability. All tenant-scoped → RLS loop.
CREATE TABLE IF NOT EXISTS crm_leads (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  lead_no text NOT NULL,                              -- LEAD-YYYYMMDD-NNN
  name text NOT NULL,
  company text,
  email text,
  phone text,
  source text,                                         -- web | referral | event | campaign | ...
  status text NOT NULL DEFAULT 'new',                 -- new | qualified | converted | lost
  owner text,
  customer_no text,                                    -- set on conversion → customer_master
  lost_reason text,
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_lead_no ON crm_leads (tenant_id, lead_no);

CREATE TABLE IF NOT EXISTS crm_opportunities (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  opp_no text NOT NULL,                                -- OPP-YYYYMMDD-NNN
  customer_no text,                                    -- → customer_master
  name text NOT NULL,
  stage text NOT NULL DEFAULT 'prospecting',          -- prospecting | qualification | proposal | negotiation | won | lost
  amount numeric(14,2) NOT NULL DEFAULT 0,
  currency text DEFAULT 'THB',
  probability integer NOT NULL DEFAULT 10,            -- 0..100 (forecast weight)
  expected_close_date date,
  owner text,
  lost_reason text,
  lead_no text,                                        -- provenance: the lead it was converted from
  created_by text,
  created_at timestamptz DEFAULT now(),
  closed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_opp_no ON crm_opportunities (tenant_id, opp_no);
CREATE INDEX IF NOT EXISTS idx_crm_opp_stage ON crm_opportunities (tenant_id, stage);
CREATE INDEX IF NOT EXISTS idx_crm_opp_customer ON crm_opportunities (tenant_id, customer_no);

CREATE TABLE IF NOT EXISTS crm_activities (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  entity_type text NOT NULL,                           -- lead | opportunity
  entity_no text NOT NULL,                             -- the lead_no / opp_no
  type text NOT NULL,                                  -- call | email | meeting | note | task
  subject text,
  notes text,
  due_date date,
  done boolean NOT NULL DEFAULT false,
  owner text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_activity_entity ON crm_activities (tenant_id, entity_type, entity_no);

-- Re-run the RLS loop so the new tenant_id tables are isolation-scoped (idempotent — DROP POLICY IF EXISTS).
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

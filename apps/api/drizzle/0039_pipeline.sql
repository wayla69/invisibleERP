-- 0039_pipeline: Phase 20 Batch 2A — Sales Pipeline
-- pipeline_stages, opportunities, opportunity_activities

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id                   bigserial PRIMARY KEY,
  tenant_id            bigint REFERENCES tenants(id),
  name                 text NOT NULL,
  sequence             int  NOT NULL DEFAULT 0,
  default_probability  int  NOT NULL DEFAULT 0,
  is_won               boolean DEFAULT false,
  is_lost              boolean DEFAULT false,
  is_active            boolean DEFAULT true,
  UNIQUE(tenant_id, name)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ps_stage_tenant ON pipeline_stages(tenant_id, sequence);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS opportunities (
  id              bigserial PRIMARY KEY,
  tenant_id       bigint REFERENCES tenants(id),
  opp_no          text NOT NULL UNIQUE,
  name            text NOT NULL,
  account_name    text,
  stage_id        bigint REFERENCES pipeline_stages(id),
  probability     int  NOT NULL DEFAULT 0,
  expected_value  numeric(18,4) NOT NULL DEFAULT 0,
  currency        text NOT NULL DEFAULT 'THB',
  expected_close  date,
  status          text NOT NULL DEFAULT 'Open',
  assigned_to     text,
  win_reason      text,
  loss_reason     text,
  notes           text,
  created_by      text,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_opp_tenant ON opportunities(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_opp_stage  ON opportunities(stage_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS opportunity_activities (
  id             bigserial PRIMARY KEY,
  opp_id         bigint NOT NULL REFERENCES opportunities(id),
  activity_type  text NOT NULL,
  subject        text NOT NULL,
  notes          text,
  activity_date  date,
  completed      boolean DEFAULT false,
  created_by     text,
  created_at     timestamptz DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_opp_act_opp ON opportunity_activities(opp_id);

--> statement-breakpoint
-- RLS for pipeline_stages and opportunities (tenant-scoped)
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='tenant_id'
      AND table_name IN ('pipeline_stages','opportunities')
  LOOP
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

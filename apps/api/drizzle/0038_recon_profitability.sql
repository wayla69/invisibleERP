-- 0038_recon_profitability: Phase 20 Batch 1C
-- Account Reconciliation (recon_periods, recon_items)
-- CO-PA Profitability (profit_segments, allocation_rules, allocation_weights, allocation_runs, allocation_lines)

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS recon_periods (
  id                bigserial PRIMARY KEY,
  tenant_id         bigint REFERENCES tenants(id),
  account_code      text NOT NULL,
  period            text NOT NULL,
  status            text NOT NULL DEFAULT 'Open',
  gl_balance        numeric(18,4) NOT NULL DEFAULT 0,
  subledger_balance numeric(18,4) NOT NULL DEFAULT 0,
  prepared_by       text,
  prepared_at       timestamptz,
  certified_by      text,
  certified_at      timestamptz,
  created_at        timestamptz DEFAULT now(),
  UNIQUE(tenant_id, account_code, period)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_rp_tenant ON recon_periods(tenant_id, period);

--> statement-breakpoint
-- source: 'GL' | 'Subledger' | 'Adjustment'
CREATE TABLE IF NOT EXISTS recon_items (
  id              bigserial PRIMARY KEY,
  recon_period_id bigint NOT NULL REFERENCES recon_periods(id),
  source          text NOT NULL,
  ref_doc         text,
  ref_line_id     bigint,
  amount          numeric(18,4) NOT NULL,
  matched_item_id bigint,
  is_matched      boolean DEFAULT false,
  notes           text,
  created_at      timestamptz DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ri_period  ON recon_items(recon_period_id);
CREATE INDEX IF NOT EXISTS idx_ri_matched ON recon_items(recon_period_id, is_matched);

--> statement-breakpoint
-- segmentType: 'Brand' | 'Channel' | 'Product' | 'Region'
CREATE TABLE IF NOT EXISTS profit_segments (
  id           bigserial PRIMARY KEY,
  tenant_id    bigint REFERENCES tenants(id),
  segment_type text NOT NULL,
  code         text NOT NULL,
  name         text NOT NULL,
  is_active    boolean DEFAULT true,
  created_at   timestamptz DEFAULT now(),
  UNIQUE(tenant_id, segment_type, code)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ps_tenant ON profit_segments(tenant_id, segment_type);

--> statement-breakpoint
-- driver: 'equal' | 'percent' | 'revenue'
CREATE TABLE IF NOT EXISTS allocation_rules (
  id                  bigserial PRIMARY KEY,
  tenant_id           bigint REFERENCES tenants(id),
  name                text NOT NULL,
  from_account_code   text NOT NULL,
  to_segment_type     text NOT NULL,
  driver              text NOT NULL DEFAULT 'equal',
  is_active           boolean DEFAULT true,
  created_at          timestamptz DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_tenant ON allocation_rules(tenant_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS allocation_weights (
  id           bigserial PRIMARY KEY,
  rule_id      bigint NOT NULL REFERENCES allocation_rules(id),
  segment_code text NOT NULL,
  weight       numeric(10,4) NOT NULL DEFAULT 1.0000,
  UNIQUE(rule_id, segment_code)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_aw_rule ON allocation_weights(rule_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS allocation_runs (
  id         bigserial PRIMARY KEY,
  tenant_id  bigint REFERENCES tenants(id),
  period     text NOT NULL,
  status     text NOT NULL DEFAULT 'Draft',
  run_by     text,
  run_at     timestamptz DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_allrun_tenant ON allocation_runs(tenant_id, period);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS allocation_lines (
  id               bigserial PRIMARY KEY,
  run_id           bigint NOT NULL REFERENCES allocation_runs(id),
  rule_id          bigint REFERENCES allocation_rules(id),
  segment_code     text NOT NULL,
  segment_type     text NOT NULL,
  account_code     text NOT NULL,
  allocated_amount numeric(18,4) NOT NULL DEFAULT 0
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_alline_run ON allocation_lines(run_id, segment_code);

--> statement-breakpoint
-- RLS for tenant-scoped tables
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='tenant_id'
      AND table_name IN ('recon_periods','profit_segments','allocation_rules','allocation_runs')
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

-- 0037_consolidation: Phase 20 Batch 1B — Financial Consolidation
-- consolidation_groups, consolidation_entities, consolidation_runs, consolidation_run_lines
-- Also seeds COA accounts 3200 (CTA) and 3300 (NCI) used in consolidation output.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS consolidation_groups (
  id            bigserial PRIMARY KEY,
  tenant_id     bigint REFERENCES tenants(id),
  name          text NOT NULL,
  base_currency text NOT NULL DEFAULT 'THB',
  fiscal_year   int  NOT NULL,
  notes         text,
  created_by    text,
  created_at    timestamptz DEFAULT now()
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cg_tenant ON consolidation_groups(tenant_id, fiscal_year);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS consolidation_entities (
  id                bigserial PRIMARY KEY,
  group_id          bigint NOT NULL REFERENCES consolidation_groups(id),
  entity_tenant_id  bigint NOT NULL REFERENCES tenants(id),
  ownership_pct     numeric(7,4) NOT NULL DEFAULT 100.0000,
  entity_currency   text NOT NULL DEFAULT 'THB',
  is_active         boolean DEFAULT true,
  UNIQUE(group_id, entity_tenant_id)
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ce_group ON consolidation_entities(group_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS consolidation_runs (
  id         bigserial PRIMARY KEY,
  group_id   bigint NOT NULL REFERENCES consolidation_groups(id),
  period     text NOT NULL,
  status     text NOT NULL DEFAULT 'Draft',
  run_at     timestamptz DEFAULT now(),
  run_by     text
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cr_group ON consolidation_runs(group_id, period);

--> statement-breakpoint
-- lineType: 'Entity' | 'Elimination' | 'FX_CTA' | 'NCI'
CREATE TABLE IF NOT EXISTS consolidation_run_lines (
  id                bigserial PRIMARY KEY,
  run_id            bigint NOT NULL REFERENCES consolidation_runs(id),
  line_type         text NOT NULL,
  entity_tenant_id  bigint,
  account_code      text NOT NULL,
  amount_thb        numeric(18,4) NOT NULL DEFAULT 0,
  notes             text
);

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crl_run ON consolidation_run_lines(run_id, account_code);

--> statement-breakpoint
-- Seed COA accounts for consolidation (CTA + NCI) — idempotent
INSERT INTO accounts(code, name, type) VALUES
  ('3200', 'Cumulative Translation Adjustment', 'Equity'),
  ('3300', 'Non-Controlling Interest',           'Equity')
ON CONFLICT(code) DO NOTHING;

--> statement-breakpoint
-- RLS for consolidation_groups (HQ-owned, tenant_id = HQ)
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
    WHERE table_schema='public' AND column_name='tenant_id'
      AND table_name IN ('consolidation_groups')
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

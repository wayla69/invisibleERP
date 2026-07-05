-- 0250_progress_billing — Construction/real-estate vertical Track A (docs/35 P1, PROJ-15). Progress billing /
-- งวดงาน: a construction contract is billed in periodic progress CLAIMS. Each claim values the work done to
-- date by BoQ line (cumulative % complete → value-to-date), the movement since the previous certified claim is
-- the value billed THIS claim, RETENTION (เงินประกันผลงาน) is withheld per the retention %, and the NET is
-- invoiced. Certification is maker-checker (raise ≠ certify → PROJ-15). On certify the claim posts revenue +
-- splits AR into net (1100) + retention receivable (1170) and withholds the retention into the shared
-- retention sub-ledger (migration 0249). Tenant-scoped (RLS + tenant-leading index).
CREATE TABLE IF NOT EXISTS project_progress_claims (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  project_id bigint NOT NULL,
  claim_no text NOT NULL,                          -- business key (PC-YYYYMMDD-NNN)
  seq integer NOT NULL DEFAULT 1,                   -- 1-based claim number on the project (งวดที่)
  period text,                                      -- billing period label (e.g. 2026-07)
  status text NOT NULL DEFAULT 'draft',            -- draft | certified | invoiced | paid
  gross_this_claim numeric(16,2) NOT NULL DEFAULT 0, -- Σ value_this_claim over the lines
  prev_certified numeric(16,2) NOT NULL DEFAULT 0,  -- cumulative gross certified on prior claims
  cumulative_certified numeric(16,2) NOT NULL DEFAULT 0, -- prev_certified + gross_this_claim
  retention_pct numeric(9,4) NOT NULL DEFAULT 0,    -- % withheld from this claim
  retention_amount numeric(16,2) NOT NULL DEFAULT 0,
  net_payable numeric(16,2) NOT NULL DEFAULT 0,     -- gross − retention (the amount invoiced)
  cost_recognized numeric(16,2) NOT NULL DEFAULT 0, -- WIP relieved to COGS at certification
  entry_no text,                                    -- the certification JE
  created_by text,
  certified_by text,                                -- checker — must differ from created_by (SoD, PROJ-15)
  certified_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pclaim_project ON project_progress_claims (tenant_id, project_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_pclaim_no ON project_progress_claims (claim_no);
--> statement-breakpoint
-- Per-BoQ-line valuation of a claim. value_to_date = boq_line.budget_amount × pct_complete_to_date/100;
-- value_this_claim = value_to_date − previously_certified (the movement billed this claim; may be negative on
-- a down-valuation but cumulative can never exceed the line budget — pct ≤ 100).
CREATE TABLE IF NOT EXISTS progress_claim_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  claim_id bigint NOT NULL,
  boq_line_id bigint NOT NULL,
  description text,
  budget_amount numeric(16,2) NOT NULL DEFAULT 0,       -- snapshot of the BoQ line contract value
  pct_complete_to_date numeric(9,4) NOT NULL DEFAULT 0, -- 0..100
  value_to_date numeric(16,2) NOT NULL DEFAULT 0,
  previously_certified numeric(16,2) NOT NULL DEFAULT 0,
  value_this_claim numeric(16,2) NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pclaim_line_claim ON progress_claim_lines (claim_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pclaim_line_boq ON progress_claim_lines (tenant_id, boq_line_id);
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

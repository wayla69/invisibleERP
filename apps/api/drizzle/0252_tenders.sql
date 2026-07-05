-- 0252_tenders — Construction/real-estate vertical Track C (docs/35 P3, PROJ-17). Tender / estimating →
-- award: the pre-award bridge between the CRM pipeline and the BoQ. A tender is an ESTIMATE — a draft BoQ with
-- a cost build-up (qty × unit_cost = cost; bid_rate = unit_cost × (1 + markup%); bid_price = Σ) tracked
-- estimating → submitted → won/lost. Nothing hits GL (a modelling surface). On WIN → award seeds a PROJECT
-- and a DRAFT BoQ from the tender lines (bid_rate → BoQ rate) in one step, so the won estimate becomes the
-- project's budget baseline — and the seeded BoQ enters draft → the existing maker-checker approve (PROJ-12),
-- keeping the budget baseline controlled. Tenant-scoped (RLS + tenant-leading index).
CREATE TABLE IF NOT EXISTS project_tenders (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  tender_no text NOT NULL,                          -- business key (TND-YYYYMMDD-NNN)
  crm_opp_no text,                                  -- optional link to a crm_opportunities deal (traceability)
  title text NOT NULL,
  customer_name text,
  project_code_hint text,                           -- preferred project code on award (nullable)
  markup_pct numeric(9,4) NOT NULL DEFAULT 0,       -- default line markup
  estimated_cost numeric(16,2) NOT NULL DEFAULT 0,  -- Σ line cost (qty × unit_cost)
  bid_price numeric(16,2) NOT NULL DEFAULT 0,       -- Σ line bid (qty × bid_rate)
  status text NOT NULL DEFAULT 'estimating',        -- estimating | submitted | won | lost
  outcome_reason text,
  submitted_at timestamptz,
  awarded_project_code text,                        -- set once awarded (idempotency)
  awarded_at timestamptz,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tender_tenant ON project_tenders (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_tender_no ON project_tenders (tender_no);
--> statement-breakpoint
-- A draft-BoQ estimate line with cost build-up. bid_rate = unit_cost × (1 + markup_pct/100).
CREATE TABLE IF NOT EXISTS tender_boq_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  tender_id bigint NOT NULL,
  line_no integer NOT NULL DEFAULT 0,
  category text NOT NULL DEFAULT 'material',         -- material | labor | subcon | other
  description text,
  uom text,
  qty numeric(18,4) NOT NULL DEFAULT 0,
  unit_cost numeric(16,2) NOT NULL DEFAULT 0,
  markup_pct numeric(9,4) NOT NULL DEFAULT 0,
  bid_rate numeric(16,2) NOT NULL DEFAULT 0,          -- unit_cost × (1 + markup_pct/100)
  cost_amount numeric(16,2) NOT NULL DEFAULT 0,       -- qty × unit_cost
  bid_amount numeric(16,2) NOT NULL DEFAULT 0,        -- qty × bid_rate
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tender_line_tender ON tender_boq_lines (tender_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tender_line_tenant ON tender_boq_lines (tenant_id, tender_id);
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

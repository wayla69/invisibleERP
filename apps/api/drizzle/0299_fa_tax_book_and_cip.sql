-- 0299_fa_tax_book_and_cip — Fixed-assets parallel TAX depreciation book + CIP/AUC settlement (FIN-6, FA-13).
-- (1) fixed_assets gains a memo-only parallel TAX depreciation basis (tax life / salvage / initial-allowance %
--     + running tax accumulated depreciation & NBV & last-period). It posts NO GL — it exists solely to feed
--     the book-vs-tax temporary difference into the deferred-tax module (TAX-06) instead of manual GAAP
--     adjustments. NULL tax_net_book_value ⇒ no tax book (deferred tax falls back to the TAX_DEP_FACTOR
--     approximation, pre-FIN-6 behaviour). Also source_cip_no for CIP→FA traceability.
-- (2) cip_assets / cip_cost_lines: Construction-in-Progress / Assets-under-Construction. A CIP asset
--     accumulates cost lines into the CIP GL account (1520) and is settled/capitalised into a normal fixed
--     asset under a maker-checker gate (new control FA-13): a settlement REQUEST (mandatory reason) posts
--     nothing; a DIFFERENT user approves before the fixed asset + reclassification JE (Dr 1500 / Cr 1520) post.
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS source_cip_no text;
--> statement-breakpoint
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS tax_useful_life_months integer;
--> statement-breakpoint
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS tax_salvage_value numeric(18,4);
--> statement-breakpoint
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS tax_initial_allowance_pct numeric(9,4);
--> statement-breakpoint
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS tax_accumulated_depreciation numeric(18,4);
--> statement-breakpoint
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS tax_net_book_value numeric(18,4);
--> statement-breakpoint
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS tax_last_depreciated_period text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cip_assets (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  cip_no text NOT NULL,
  name text NOT NULL,
  category_id bigint REFERENCES asset_categories(id),
  status text NOT NULL DEFAULT 'Open',
  accumulated_cost numeric(18,4) NOT NULL DEFAULT 0,
  location text,
  department text,
  notes text,
  settle_name text,
  settle_category_id bigint,
  settle_useful_life_months integer,
  settle_salvage_value numeric(18,4),
  settle_tax_useful_life_months integer,
  settle_tax_initial_allowance_pct numeric(9,4),
  settle_reason text,
  settled_asset_no text,
  settle_journal_no text,
  requested_by text,
  requested_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  reject_reason text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_cip_no ON cip_assets (tenant_id, cip_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cip_status ON cip_assets (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS cip_cost_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  cip_id bigint NOT NULL REFERENCES cip_assets(id),
  cip_no text NOT NULL,
  source_type text NOT NULL DEFAULT 'manual',
  source_ref text,
  description text,
  amount numeric(18,4) NOT NULL,
  cost_date date,
  pay_source text NOT NULL DEFAULT 'credit',
  gl_ref text,
  added_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cip_cost_cip ON cip_cost_lines (tenant_id, cip_no);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new tables
-- get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

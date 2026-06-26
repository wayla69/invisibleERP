-- WS3.3 — Consolidation eliminations integrity (CON-03) + segment reporting (CON-04).
-- Extends the existing CON-01 consolidation engine (consolidation_groups/_entities/_runs/_run_lines,
-- migration 0037) with:
--   * consol_elimination_rules — configurable elimination rules (IC balance / IC revenue / investment /
--                                manual) so generateEliminations is not hard-wired to the 1150/2150 pair.
--   * segment_definitions      — map dimension values (branch/project/department/entity) into IFRS-8
--                                reporting segments for the segment P&L report.
--   * consolidation_runs gets a maker-checker run→post lifecycle: balanced flag (CON-03 = consolidated TB
--                                Σdr=Σcr after eliminations), posted_by / posted_at (a DIFFERENT user posts;
--                                self-post → SELF_POST). The consolidated TB becomes the official group
--                                result for the period when Posted; eliminations live at the group layer
--                                (consolidation_run_lines), NOT in any operating entity's GL.
-- All three carry tenant_id (group-owner / HQ tenant) so the RLS loop isolates them; an HQ/Admin
-- (app.bypass_rls = on, set by tenant-tx.interceptor for role Admin) reads ACROSS member tenants — the
-- same cross-tenant path CON-01 / closeYear / multi-tenant depreciation already rely on.
ALTER TABLE consolidation_runs ADD COLUMN IF NOT EXISTS balanced boolean;
--> statement-breakpoint
ALTER TABLE consolidation_runs ADD COLUMN IF NOT EXISTS posted_by text;
--> statement-breakpoint
ALTER TABLE consolidation_runs ADD COLUMN IF NOT EXISTS posted_at timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS consol_elimination_rules (
  id                    bigserial PRIMARY KEY,
  tenant_id             bigint REFERENCES tenants(id),
  group_id              bigint NOT NULL REFERENCES consolidation_groups(id),
  name                  text NOT NULL,
  rule_type             text NOT NULL DEFAULT 'ic_balance',  -- ic_balance | ic_revenue | investment | manual
  match_account_pattern text,
  debit_account         text,
  credit_account        text,
  active                boolean DEFAULT true,
  created_at            timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cer_group ON consol_elimination_rules (group_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS segment_definitions (
  id          bigserial PRIMARY KEY,
  tenant_id   bigint REFERENCES tenants(id),
  code        text NOT NULL,
  name        text NOT NULL,
  dimension   text NOT NULL DEFAULT 'branch',  -- branch | project | department | entity
  member_keys jsonb,
  active       boolean DEFAULT true,
  created_at  timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_segdef_tenant ON segment_definitions (tenant_id, dimension);
--> statement-breakpoint
-- Re-run the RLS loop so the two new tenant_id tables are isolation-scoped (idempotent — DROP POLICY IF EXISTS).
-- WITH CHECK + the app.bypass_rls escape mirror 0167/0169 so an HQ/Admin (bypass) consolidation run/post can
-- write these group-level config/run rows while reading across member tenants.
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

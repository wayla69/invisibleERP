-- 0341_std_cost_revisions — INV-4: standard-cost roll / inventory revaluation (control COST-02).
-- A STD-costed item's standard cost was set ONCE via /api/costing/config (item_costing.standard_cost) and
-- never rolled. Over time the frozen standard drifts from real cost → on-hand inventory (valued at standard)
-- is mis-stated and no independent control governs the change. This adds a MAKER-CHECKER standard-cost
-- revision: a preparer proposes a new standard per item (snapshotting current on-hand), a DISTINCT approver
-- approves (approved_by ≠ prepared_by → 403 SOD_SELF_APPROVAL), and on approval the on-hand is REVALUED at the
-- new standard (revaluation = on_hand_snapshot × (new_std − old_std)), the stored standard rolls forward, and a
-- balanced revaluation JE posts (Dr/Cr 1200 Inventory ↔ 5500 std-cost variance — the PPV convention).
--   • std_cost_revisions — header (status Draft/Approved, preparer/approver, revaluation total, posted JE ref)
--   • std_cost_revision_lines — per item: old_std, new_std, on_hand_snapshot, revaluation_amount
-- Both tenant-scoped: a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation RLS policy
-- (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS std_cost_revisions (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  rev_no text NOT NULL,
  status text NOT NULL DEFAULT 'Draft',
  reason text,
  revaluation_total numeric(18,2) DEFAULT 0,
  je_no text,
  prepared_by text,
  prepared_at timestamptz DEFAULT now(),
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_std_cost_rev_no ON std_cost_revisions (rev_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_std_cost_rev_tenant ON std_cost_revisions (tenant_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS std_cost_revision_lines (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  rev_no text NOT NULL,
  item_id text NOT NULL,
  old_std numeric(14,4),
  new_std numeric(14,4),
  on_hand_snapshot numeric(18,4),
  revaluation_amount numeric(18,2),
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_std_cost_rev_line_tenant ON std_cost_revision_lines (tenant_id, rev_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_std_cost_rev_line_item ON std_cost_revision_lines (tenant_id, item_id);
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

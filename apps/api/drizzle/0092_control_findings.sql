-- 0092 — Continuous controls monitoring (Platform Phase 19 — B5). Detective controls that scan the books
-- for red flags (duplicate vendor invoices, split POs under an approval threshold, ghost/duplicate vendors,
-- AP-over-PO margin leakage). Read-only monitor; findings are surfaced for human review and post NOTHING to
-- the GL. New tenant_id table → RLS loop re-run.

CREATE TABLE IF NOT EXISTS control_findings (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  control_key text NOT NULL,                 -- duplicate_invoice | split_po | ghost_vendor | margin_leakage
  severity text NOT NULL DEFAULT 'warning',  -- info | warning | critical
  entity_ref text,
  detail text,
  amount numeric(18,2),
  status text NOT NULL DEFAULT 'open',        -- open | reviewed | dismissed
  fingerprint text NOT NULL,                  -- stable hash; re-scans upsert instead of duplicating
  detected_at timestamptz DEFAULT now(),
  reviewed_by text,
  reviewed_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_control_findings_fp ON control_findings (tenant_id, fingerprint);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_control_findings_scope ON control_findings (tenant_id, status, control_key);
--> statement-breakpoint

-- Re-run the 0002 RLS loop so the new tenant_id table is isolation-scoped.
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

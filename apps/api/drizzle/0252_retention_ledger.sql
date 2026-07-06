-- 0252_retention_ledger — Construction/real-estate vertical Phase 0 (docs/35). The SHARED retention
-- sub-ledger that Tracks A (customer progress billing / งวดงาน) and B (subcontractor valuations) both build
-- on. A contract withholds retention (เงินประกันผลงาน, e.g. 5–10%) on each certified claim/valuation and
-- releases it in tranches (typically part on practical completion, the remainder at the end of the
-- defect-liability period). This ledger tracks withheld vs released per party/document (outstanding =
-- withheld − released) with an optional release schedule. It records balances only — the GL journal
-- (Dr/Cr the retention receivable 1170 / payable 2440 account) is posted by the certifying service (A/B) in
-- the same transaction, exactly as the commitment ledger (docs/32) records encumbrance without posting GL.
-- Tenant-scoped (RLS + tenant-leading index), copies the CANONICAL 0232 org-clause policy body.
CREATE TABLE IF NOT EXISTS retention_ledger (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  party_type text NOT NULL,                       -- customer | subcontractor
  project_id bigint,                              -- the project this retention relates to (nullable)
  party_ref text,                                 -- customer name / subcontract no (free-text reference)
  source_doc_type text NOT NULL DEFAULT 'MANUAL', -- CLAIM (progress claim) | SUBVAL (subcontract valuation) | MANUAL
  source_doc_no text NOT NULL,
  gl_account text NOT NULL,                        -- 1170 (retention receivable) | 2440 (retention payable)
  withheld_amount numeric(16,2) NOT NULL DEFAULT 0,
  released_amount numeric(16,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'held',            -- held | partially_released | released
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_retention_project ON retention_ledger (tenant_id, project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_retention_source ON retention_ledger (source_doc_type, source_doc_no);
--> statement-breakpoint
-- Release schedule — the tranches by which the withheld amount becomes due (basis: a fixed date, practical
-- completion, or defect-liability-period end). A pending tranche whose due_date has passed surfaces on the
-- retention "due" worklist (later: the /projects/action-center `retention_due` exception).
CREATE TABLE IF NOT EXISTS retention_release_schedule (
  id bigserial PRIMARY KEY,
  tenant_id bigint,
  retention_id bigint NOT NULL,
  tranche_no integer NOT NULL DEFAULT 1,
  due_basis text NOT NULL DEFAULT 'date',         -- date | practical_completion | dlp_end
  pct numeric(9,4),                               -- % of the withheld amount for this tranche (nullable if amount given)
  amount numeric(16,2) NOT NULL DEFAULT 0,        -- tranche amount (= pct% of withheld, or explicit)
  due_date date,
  status text NOT NULL DEFAULT 'pending',         -- pending | released
  released_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_retention_sched_ret ON retention_release_schedule (retention_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_retention_sched_due ON retention_release_schedule (tenant_id, status, due_date);
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

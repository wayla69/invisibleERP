-- 0417 — SME-02 (docs/49): period sign-off / attestation for the SME-01 self-approval review.
-- SME-01 (sme_self_approval_review) PRODUCES the detective review; SME-02 EVIDENCES that it was operated:
-- the independent reviewers — the external accountant (a tenant user holding the `sme_review` duty) and the
-- platform owner (god, acting-as the tenant) — each attest that they reviewed a period's self-approvals.
-- One attestation per (tenant, period, reviewer_kind); re-signing refreshes the snapshot + timestamp.
CREATE TABLE IF NOT EXISTS sme_review_signoffs (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  period text NOT NULL,                      -- review period, 'YYYY-MM' (business-month, Asia/Bangkok)
  reviewer_kind text NOT NULL,               -- 'accountant' (tenant-side independent reviewer) | 'platform' (god)
  reviewer_username text NOT NULL,           -- who attested
  item_count integer NOT NULL DEFAULT 0,     -- self-approvals in the period, snapshot at sign-off time
  total_amount numeric(14,2) NOT NULL DEFAULT 0,
  note text,                                 -- optional reviewer remark
  signed_at timestamptz DEFAULT now(),
  CONSTRAINT sme_review_signoffs_uq UNIQUE (tenant_id, period, reviewer_kind)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sme_review_signoffs_tenant ON sme_review_signoffs (tenant_id, period);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) to every
-- tenant-scoped table incl. this one. Idempotent. (PGlite executes this DO-loop too — no parallel list.)
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

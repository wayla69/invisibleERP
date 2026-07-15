-- 0412 — SME single-user edition (docs/49, SME-01): per-tenant control profile + self-approval evidence
-- + platform-wide SME provisioning defaults.
-- tenants.control_profile: 'enterprise' (full maker-checker, default) | 'sme' (single operator may
-- self-approve WITH a mandatory logged reason; every such approval lands in self_approvals for the
-- SME-01 detective review). Transition is upgrade-only (sme -> enterprise) — enforced in the service.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS control_profile text NOT NULL DEFAULT 'enterprise';
--> statement-breakpoint
-- Per-tenant stamped copy of the platform SME defaults taken at provisioning time (hidden nav groups,
-- SME-01 accountant routing). Later changes to platform_sme_defaults affect only future companies.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sme_prefs jsonb NOT NULL DEFAULT '{}';
--> statement-breakpoint
-- SME-01 evidence: one row per ALLOWED self-approval (maker == checker under control_profile='sme').
-- Written only by ControlProfileService.assertMakerChecker; read by the sme_self_approval_review report.
CREATE TABLE IF NOT EXISTS self_approvals (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id),
  event text NOT NULL,                -- maker-checker event key, e.g. 'gl.je.approve', 'cpq.discount.approve'
  ref text NOT NULL,                  -- business document reference (JE no, quote no, card no, ...)
  username text NOT NULL,             -- the person who was both maker and checker
  amount numeric(14,2),               -- THB at stake, when the event is monetary
  reason text NOT NULL,               -- mandatory justification (SELF_APPROVAL_REASON_REQUIRED without it)
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_self_approvals_tenant ON self_approvals (tenant_id, created_at);
--> statement-breakpoint
-- Platform-level single-row config (god-only): the defaults every NEW SME company is stamped with at
-- provisioning. Deliberately NO tenant_id-named column — platform table, the RLS loop + tenant-index
-- guard must skip it (pattern: platform_notifications / signup_requests).
CREATE TABLE IF NOT EXISTS platform_sme_defaults (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  hidden_nav_groups jsonb NOT NULL DEFAULT '[]',  -- nav group title keys hidden for SME tenants
  accountant_email text,                           -- default external-accountant recipient for SME-01
  updated_by text,
  updated_at timestamptz DEFAULT now()
);
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

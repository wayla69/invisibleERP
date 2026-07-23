-- 0471_mi_campaign_generations
-- docs/61 Phase 4 — AI Campaign Studio (control MKT-21). Generate a fact-grounded campaign — audience,
-- channel, send-time, offer, th/en copy — from a segment FACT SHEET (size, avg CLV, dominant next-best-
-- action, best channel by MMM ROI, modal send-hour), fed to the generator as retrieval-grounded context
-- (facts in the prompt, not hallucinated). The output is a DRAFT campaign (consent-gated, maker-checker on
-- send stays the existing campaign flow); this table LOGS the model card — the fact sheet, the prompt, the
-- model, the produced draft — as the ICFR evidence that a campaign was fact-grounded + draft-only.
--
-- Tenancy: tenant_id → the canonical 0232-form org RLS policy (trailing DO block) + a LEADING index.

CREATE TABLE IF NOT EXISTS mi_campaign_generations (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  gen_no text NOT NULL,                                  -- GEN-YYYYMMDD-NNN
  segment text,
  channel text,
  model text NOT NULL DEFAULT 'studio-template-v1',      -- the model that produced the copy
  prompt text,                                           -- the retrieval-grounded prompt (facts in, not hallucinated)
  facts jsonb,                                           -- the segment fact sheet the draft was grounded in
  draft jsonb,                                           -- the produced draft (audience, channel, hour, offer, th/en copy)
  campaign_id bigint,                                    -- the consent-gated campaign DRAFT created (null = preview only)
  requested_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mi_gen_tenant ON mi_campaign_generations (tenant_id, created_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ux_mi_gen_no ON mi_campaign_generations (tenant_id, gen_no);
--> statement-breakpoint

-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form). Idempotent.
-- EXCLUDE audit_expectations: migration 0465 deliberately gives it a PERMISSIVE tenant_isolation policy
-- (USING/CHECK true) so the in-business-tx audit-expectation bump never violates RLS and aborts the tx
-- (a god acting-as a company bumps under the TARGET app.tenant_id) — re-applying the scoped 0232 body
-- here would reintroduce a 500 on god sign-off (cf. the 0218 org-clause clobber gotcha). Leave it untouched.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' AND table_name <> 'audit_expectations' LOOP
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

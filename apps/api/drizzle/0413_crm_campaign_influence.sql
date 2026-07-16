-- 0413_crm_campaign_influence — CRM-15 multi-touch campaign attribution (control CRM-17).
-- Today the source-ROI read credits a won deal's revenue to a SINGLE touch (the lead source), so campaign ROI
-- is mis-stated and multi-touch marketing spend is decided on inaccurate attribution. This table records each
-- campaign TOUCHPOINT that influenced an opportunity (campaign_name is CRM-owned free text — no cross-domain
-- FK/join into the marketing tables), so a won deal's amount can be distributed across its touchpoints under an
-- explicit attribution MODEL (first-touch / last-touch / linear / U-shaped). Every model conserves the total
-- (Σ attributed = the deal amount), so attributed campaign revenue reconciles to won revenue.
-- One tenant table (0232 canonical RLS, tenant-leading index).

CREATE TABLE IF NOT EXISTS crm_campaign_influence (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  opportunity_id bigint NOT NULL REFERENCES crm_opportunities(id),
  campaign_name text NOT NULL,                      -- CRM-owned label (may mirror a marketing campaign)
  touch_type text NOT NULL DEFAULT 'other',          -- lead_source | meeting | email | event | webinar | content | other
  touched_at date NOT NULL,
  note text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_campaign_influence_tenant ON crm_campaign_influence (tenant_id, opportunity_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_campaign_influence_opp ON crm_campaign_influence (opportunity_id, touched_at);
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

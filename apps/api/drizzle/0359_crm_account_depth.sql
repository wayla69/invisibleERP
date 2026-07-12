-- 0359_crm_account_depth — CRM-7 (B2B Account/Contact 360 depth, control REV-24). Net-new depth on the
-- REV-17 CRM pipeline spine (no change to the lead→convert→opportunity paths). Three additions:
--   • crm_accounts.parent_account_id — a self-referential PARENT link so a company can be modelled as a
--     hierarchy (parent ⋈ subsidiaries); the set-parent endpoint rejects cycles (HIERARCHY_CYCLE) and the
--     hierarchy read rolls the open weighted pipeline up the subtree.
--   • crm_opportunity_contacts — the per-deal BUYING COMMITTEE: which contacts sit on a deal, each with a
--     role (decision_maker / champion / influencer / evaluator / blocker / user) and influence weight; at
--     most one is_primary per deal.
--   • crm_account_plans — a governed ACCOUNT PLAN (draft → active → closed) with an owner, objective,
--     strategy, target revenue and target product categories (validated against item_categories); the
--     whitespace read diffs the tenant's active item_categories against the account's active-plan targets.
-- All new tables carry tenant_id and are enrolled by the canonical 0232-form RLS DO-loop at the end.

ALTER TABLE crm_accounts ADD COLUMN IF NOT EXISTS parent_account_id bigint REFERENCES crm_accounts(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_account_parent ON crm_accounts (tenant_id, parent_account_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS crm_opportunity_contacts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  opportunity_id bigint NOT NULL REFERENCES crm_opportunities(id),
  contact_id bigint NOT NULL REFERENCES crm_contacts(id),
  role text NOT NULL DEFAULT 'user',        -- decision_maker | champion | influencer | evaluator | blocker | user
  influence text NOT NULL DEFAULT 'medium', -- high | medium | low
  is_primary boolean NOT NULL DEFAULT false,
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_opp_contact ON crm_opportunity_contacts (tenant_id, opportunity_id, contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_opp_contact_opp ON crm_opportunity_contacts (tenant_id, opportunity_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS crm_account_plans (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  plan_no text NOT NULL,                     -- APL-YYYYMMDD-NNN
  account_id bigint NOT NULL REFERENCES crm_accounts(id),
  period text,                               -- e.g. FY2026 / 2026-H1
  objective text,
  strategy text,
  target_revenue numeric(14,2) NOT NULL DEFAULT 0,
  target_categories jsonb NOT NULL DEFAULT '[]'::jsonb, -- array of item_categories.code
  status text NOT NULL DEFAULT 'draft',      -- draft | active | closed
  owner text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_account_plan_no ON crm_account_plans (tenant_id, plan_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_account_plan_account ON crm_account_plans (tenant_id, account_id);
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

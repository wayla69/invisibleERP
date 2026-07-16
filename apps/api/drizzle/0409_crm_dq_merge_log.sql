-- 0409_crm_dq_merge_log — CRM-17 data-quality scoring + merge audit (control CRM-16).
-- crm_dq_scores is a per-account DATA-QUALITY snapshot (mirrors crm_account_health_snapshots): a daily score
-- (0..100 = weighted completeness + validity of the customer-master fields) + band for trend; the live score is
-- computed in CrmDqService. crm_merge_log is an append-only audit of every account merge (survivor, retired
-- duplicate, children reassigned, survivorship-filled fields, who/when), written inside the merge transaction so
-- it commits atomically with the merge. Two tenant tables (0232 canonical RLS, tenant-leading indexes).

CREATE TABLE IF NOT EXISTS crm_dq_scores (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  account_id bigint NOT NULL REFERENCES crm_accounts(id),
  snapshot_date date NOT NULL,
  score integer NOT NULL DEFAULT 0,               -- 0..100 (100 = complete + valid)
  band text NOT NULL DEFAULT 'poor',              -- good | fair | poor
  signals jsonb NOT NULL DEFAULT '{}',            -- per-field breakdown snapshot
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_dq_day ON crm_dq_scores (tenant_id, account_id, snapshot_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_dq_account ON crm_dq_scores (tenant_id, account_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS crm_merge_log (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  survivor_account_id bigint NOT NULL,
  survivor_no text NOT NULL,
  duplicate_account_id bigint NOT NULL,
  duplicate_no text NOT NULL,
  reassigned_children integer NOT NULL DEFAULT 0,
  filled_fields jsonb NOT NULL DEFAULT '[]',      -- survivor fields backfilled from the duplicate
  merged_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_merge_log_survivor ON crm_merge_log (tenant_id, survivor_account_id);
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

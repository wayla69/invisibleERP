-- 0278_scheduled_master_changes — master-data audit Phase 12: date-effective (future-dated) master attributes.
-- Oracle-grade master data lets a steward SCHEDULE a change to a master field to take effect on a future
-- business date (e.g. a customer's credit limit rises on the 1st of next month). The change is parked here and
-- applied by an idempotent daily job (BI scheduler action `apply_scheduled_master_changes`) once the effective
-- date arrives — never before. A change to a FRAUD-RELEVANT field (customer credit limit) is `sensitive` and
-- staged `pending_approval` until a DISTINCT approver releases it (maker-checker, audit G7 / SoD R09), so a
-- future-dated bump cannot bypass the two-person rule. Tenant-scoped (RLS), audit-logged via the trigger.
CREATE TABLE IF NOT EXISTS scheduled_master_changes (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  entity text NOT NULL,
  entity_key text NOT NULL,
  field text NOT NULL,
  new_value text NOT NULL,
  effective_date date NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  sensitive boolean NOT NULL DEFAULT false,
  requested_by text,
  approved_by text,
  note text,
  applied_at timestamptz,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scheduled_master_changes_tenant ON scheduled_master_changes (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scheduled_master_changes_due ON scheduled_master_changes (tenant_id, status, effective_date);
--> statement-breakpoint
-- Change-history trigger (0274 / ITGC-AC-14) on the new table.
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['scheduled_master_changes'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_dcl_%I ON public.%I', r, r);
    EXECUTE format('CREATE TRIGGER trg_dcl_%I AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION log_data_change()', r, r);
  END LOOP;
END $$;
--> statement-breakpoint
-- Re-run the RLS loop so the new tenant_id table is isolation-scoped. GRANT/ENABLE/FORCE from 0137,
-- CANONICAL org-clause policy body from 0232 (a plain body would silently drop cross-account org sharing).
DO $$
DECLARE r record;
BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'tenant_id'
  LOOP
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

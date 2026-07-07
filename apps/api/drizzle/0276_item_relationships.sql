-- 0276_item_relationships — master-data audit Phase 10: product-master relational depth + lifecycle.
-- The item master carried no item-to-item relationships and no lifecycle status. Adds a lifecycle status
-- (+ a superseded_by replacement pointer) on the SHARED items table (no tenant_id → tenant-neutral, no RLS
-- loop for these columns), and a TENANT-SCOPED item_relationships table (substitute/complement/supersedes/
-- kit_component/accessory) — tenant-scoped because substitutes/cross-sell are per-shop merchandising choices,
-- not global facts. RLS + tenant-leading index + change-audit trigger, like the party relationships (0275).
ALTER TABLE items ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS superseded_by bigint;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS item_relationships (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  from_item_id bigint NOT NULL REFERENCES items(id),
  to_item_id bigint NOT NULL REFERENCES items(id),
  rel_type text NOT NULL DEFAULT 'substitute',
  note text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_item_relationships_tenant ON item_relationships (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_item_relationships_from ON item_relationships (from_item_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_relationships ON item_relationships (tenant_id, from_item_id, to_item_id, rel_type);
--> statement-breakpoint
-- Change-history trigger (0274 / ITGC-AC-14) on the new relationship table.
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['item_relationships'] LOOP
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

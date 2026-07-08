-- 0288_fine_casual_guest_profiles — POS advance booking for a fine-casual house (buffet + à la carte in
-- one venue) + PDPA-consented guest dining profiles (Michelin-style guest CRM).
--   1) table_reservations gains service_mode ('a_la_carte'|'buffet', reusing the order_mode enum),
--      an optional pre-picked buffet tier, and an occasion note.
--   2) member_dining_profiles (1:1 per member): favourite menus/ingredients, allergies, dietary,
--      seating preference, typical party size, service notes + an extensible jsonb bag.
--   3) member_companions: the people the guest usually dines with (their preferences/allergies).
-- PDPA: both new tables hold consent-gated profiling data (member_consents purpose 'dining_profile');
-- DSAR export bundles them, erasure/retention HARD-DELETES them (no accounting value). RLS via the
-- canonical 0232-form loop below; tenant-leading indexes satisfy the cutover/tenant-idx gate (R1-1).
ALTER TABLE table_reservations ADD COLUMN IF NOT EXISTS service_mode order_mode NOT NULL DEFAULT 'a_la_carte';
--> statement-breakpoint
ALTER TABLE table_reservations ADD COLUMN IF NOT EXISTS buffet_package_id BIGINT REFERENCES buffet_packages(id);
--> statement-breakpoint
ALTER TABLE table_reservations ADD COLUMN IF NOT EXISTS occasion TEXT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS member_dining_profiles (
  id                   BIGSERIAL PRIMARY KEY,
  tenant_id            BIGINT NOT NULL REFERENCES tenants(id),
  member_id            BIGINT NOT NULL REFERENCES pos_members(id),
  favorite_menus       JSONB,
  favorite_ingredients JSONB,
  allergies            JSONB,
  dietary              TEXT,
  seating_preference   TEXT,
  typical_party_size   INTEGER,
  service_notes        TEXT,
  extra                JSONB,
  created_by           TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS member_dining_profiles_member_uq ON member_dining_profiles (member_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_member_dining_profiles_tenant ON member_dining_profiles (tenant_id, member_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS member_companions (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
  member_id    BIGINT NOT NULL REFERENCES pos_members(id),
  name         TEXT NOT NULL,
  relationship TEXT,
  allergies    JSONB,
  preferences  TEXT,
  notes        TEXT,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_member_companions_tenant ON member_companions (tenant_id, member_id);
--> statement-breakpoint
-- app_user grants + re-apply the CANONICAL org-scoped tenant_isolation policy (0232 form) so the new
-- tables get RLS with the org-sharing clause. Idempotent; runs on PGlite + Postgres alike.
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

-- 0293_crm_unification — CRM-1 (docs/41 module-depth uplift): unify the two disconnected opportunity models.
-- crm_opportunities (REV-17 spine) becomes the ONE opportunity table: it gains stage_id → the tenant-
-- configurable pipeline_stages (the legacy lowercase `stage` string stays in sync for back-compat), a
-- derived status (Open|Won|Lost), real account/contact/owner references, and provenance columns; the Batch
-- 2A `opportunities` rows are data-migrated in (legacy_opportunity_id) and `opportunity_activities` fold
-- into crm_activities (source='pipeline', legacy_activity_id). CPQ quotes get crm_opportunity_id (backfilled
-- through the legacy id mapping) — quotes.opportunity_id becomes read-legacy. New masters: crm_accounts
-- (company; duplicate-governed, audited survivor-pattern merge) and crm_contacts (person, role-tagged,
-- optional pos_members loyalty join). New audit: crm_stage_history (every stage transition, both routes).
-- Default pipeline_stages are seeded per tenant where missing so stage_id resolves for existing rows.
-- Tenant-scoped (RLS canonical 0232 loop + leading (tenant_id,…) indexes + app_user grants).
CREATE TABLE IF NOT EXISTS crm_accounts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  account_no text NOT NULL,
  name text NOT NULL,
  tax_id text,
  industry text,
  size text,
  email text,
  phone text,
  website text,
  owner_user_id bigint REFERENCES users(id),
  customer_no text,
  status text NOT NULL DEFAULT 'active',
  merged_into bigint,
  merged_by text,
  merged_at timestamptz,
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT uq_crm_account_no UNIQUE (tenant_id, account_no)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_account_name ON crm_accounts (tenant_id, name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_account_customer ON crm_accounts (tenant_id, customer_no);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS crm_contacts (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  account_id bigint REFERENCES crm_accounts(id),
  name text NOT NULL,
  email text,
  phone text,
  role text NOT NULL DEFAULT 'other',
  line_id text,
  member_id bigint REFERENCES pos_members(id),
  status text NOT NULL DEFAULT 'active',
  notes text,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_contact_account ON crm_contacts (tenant_id, account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_contact_email ON crm_contacts (tenant_id, email);
--> statement-breakpoint
ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS stage_id bigint REFERENCES pipeline_stages(id);
--> statement-breakpoint
ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Open';
--> statement-breakpoint
ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS owner_user_id bigint REFERENCES users(id);
--> statement-breakpoint
ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS account_id bigint REFERENCES crm_accounts(id);
--> statement-breakpoint
ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS primary_contact_id bigint REFERENCES crm_contacts(id);
--> statement-breakpoint
ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS account_name text;
--> statement-breakpoint
ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS win_reason text;
--> statement-breakpoint
ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS notes text;
--> statement-breakpoint
ALTER TABLE crm_opportunities ADD COLUMN IF NOT EXISTS legacy_opportunity_id bigint;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_opp_status ON crm_opportunities (tenant_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_opp_account ON crm_opportunities (tenant_id, account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_opp_legacy ON crm_opportunities (tenant_id, legacy_opportunity_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS crm_stage_history (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  opportunity_id bigint NOT NULL REFERENCES crm_opportunities(id),
  from_stage text,
  to_stage text NOT NULL,
  changed_by text,
  changed_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_crm_stage_history_opp ON crm_stage_history (tenant_id, opportunity_id);
--> statement-breakpoint
ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS source text;
--> statement-breakpoint
ALTER TABLE crm_activities ADD COLUMN IF NOT EXISTS legacy_activity_id bigint;
--> statement-breakpoint
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS crm_opportunity_id bigint REFERENCES crm_opportunities(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_qt_crm_opp ON quotes (crm_opportunity_id);
--> statement-breakpoint
-- Backfill the derived status on pre-existing crm rows from the legacy stage string.
UPDATE crm_opportunities SET status = CASE WHEN stage = 'won' THEN 'Won' WHEN stage = 'lost' THEN 'Lost' ELSE 'Open' END;
--> statement-breakpoint
-- Seed the six default pipeline_stages for every tenant that has opportunity data but no stage rows yet,
-- so stage_id can resolve for existing crm_opportunities (match by stage name). NULL-tenant rows are left
-- for the service's first-use seeding (the unique index does not dedupe NULL tenant rows).
INSERT INTO pipeline_stages (tenant_id, name, sequence, default_probability, is_won, is_lost, is_active)
SELECT t.tenant_id, d.name, d.sequence, d.default_probability, d.is_won, d.is_lost, true
FROM (
  SELECT DISTINCT tenant_id FROM crm_opportunities WHERE tenant_id IS NOT NULL
  UNION SELECT DISTINCT tenant_id FROM opportunities WHERE tenant_id IS NOT NULL
) t
CROSS JOIN (VALUES
  ('Prospect', 1, 10, false, false),
  ('Qualified', 2, 25, false, false),
  ('Proposal', 3, 50, false, false),
  ('Negotiation', 4, 75, false, false),
  ('Won', 5, 100, true, false),
  ('Lost', 6, 0, false, true)
) AS d(name, sequence, default_probability, is_won, is_lost)
WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages ps WHERE ps.tenant_id = t.tenant_id AND ps.name = d.name);
--> statement-breakpoint
-- Resolve stage_id for existing crm rows via the legacy-name mapping.
UPDATE crm_opportunities o SET stage_id = ps.id
FROM pipeline_stages ps
WHERE o.stage_id IS NULL AND o.tenant_id IS NOT NULL AND ps.tenant_id = o.tenant_id
  AND ps.name = CASE o.stage
    WHEN 'prospecting' THEN 'Prospect' WHEN 'qualification' THEN 'Qualified' WHEN 'proposal' THEN 'Proposal'
    WHEN 'negotiation' THEN 'Negotiation' WHEN 'won' THEN 'Won' WHEN 'lost' THEN 'Lost' ELSE o.stage END;
--> statement-breakpoint
-- Data-migrate the Batch 2A `opportunities` rows INTO crm_opportunities (idempotent on legacy_opportunity_id).
-- Field map: expected_value→amount (rounded to the spine's 2dp), expected_close→expected_close_date,
-- assigned_to→owner, loss_reason/win_reason carried, status carried, closed rows take updated_at as closed_at.
INSERT INTO crm_opportunities (
  tenant_id, opp_no, name, stage, stage_id, status, amount, currency, probability,
  expected_close_date, owner, account_name, lost_reason, win_reason, notes,
  legacy_opportunity_id, created_by, created_at, closed_at)
SELECT
  o.tenant_id, o.opp_no, o.name,
  CASE WHEN o.status = 'Won' THEN 'won' WHEN o.status = 'Lost' THEN 'lost'
       WHEN ps.name = 'Prospect' THEN 'prospecting' WHEN ps.name = 'Qualified' THEN 'qualification'
       WHEN ps.name = 'Proposal' THEN 'proposal' WHEN ps.name = 'Negotiation' THEN 'negotiation'
       WHEN ps.name = 'Won' THEN 'won' WHEN ps.name = 'Lost' THEN 'lost'
       ELSE coalesce(ps.name, 'prospecting') END,
  o.stage_id, o.status, round(o.expected_value, 2), o.currency, o.probability,
  o.expected_close, o.assigned_to, o.account_name, o.loss_reason, o.win_reason, o.notes,
  o.id, o.created_by, o.created_at,
  CASE WHEN o.status IN ('Won', 'Lost') THEN o.updated_at END
FROM opportunities o
LEFT JOIN pipeline_stages ps ON ps.id = o.stage_id
WHERE NOT EXISTS (SELECT 1 FROM crm_opportunities c WHERE c.legacy_opportunity_id = o.id);
--> statement-breakpoint
-- Fold opportunity_activities into crm_activities, tagged source='pipeline' (idempotent on legacy_activity_id).
INSERT INTO crm_activities (
  tenant_id, entity_type, entity_no, type, subject, notes, due_date, done, owner, source,
  legacy_activity_id, created_by, created_at)
SELECT c.tenant_id, 'opportunity', c.opp_no, a.activity_type, a.subject, a.notes, a.activity_date,
  coalesce(a.completed, false), a.created_by, 'pipeline', a.id, a.created_by, a.created_at
FROM opportunity_activities a
JOIN crm_opportunities c ON c.legacy_opportunity_id = a.opp_id
WHERE NOT EXISTS (SELECT 1 FROM crm_activities x WHERE x.legacy_activity_id = a.id AND x.source = 'pipeline');
--> statement-breakpoint
-- Repoint CPQ quotes at the migrated opportunities (read path prefers crm_opportunity_id).
UPDATE quotes q SET crm_opportunity_id = c.id
FROM crm_opportunities c
WHERE q.crm_opportunity_id IS NULL AND q.opportunity_id IS NOT NULL AND c.legacy_opportunity_id = q.opportunity_id;
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

-- 0353_service_kb — SVC-6 (Service Cloud): Knowledge Base + Case Deflection (SVC-06 control). Net-new, alongside
-- the SVC-4/5 case surface (no change to those paths). Two new tenant-scoped tables:
--   • kb_articles     — a per-tenant KB article with a GOVERNED publish lifecycle (draft → published →
--                       archived); an article is published only by a DIFFERENT user than its author
--                       (SVC-06 maker-checker). Usage counters: views / helpful / not_helpful.
--   • kb_deflections  — the case-deflection log: each KB-assisted interaction records the query + article +
--                       whether it DEFLECTED (self-served, no case) or a case was still opened.
-- Each new table gets a leading (tenant_id, …) index + the CANONICAL 0232-form tenant_isolation RLS policy
-- (re-applied via the generic DO-loop below) + app_user grants. Idempotent; PGlite + Postgres alike.
CREATE TABLE IF NOT EXISTS kb_articles (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  article_no text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  category text,
  tags text,
  status text NOT NULL DEFAULT 'draft', -- draft | published | archived
  author text,
  published_by text,
  published_at timestamptz,
  views bigint NOT NULL DEFAULT 0,
  helpful bigint NOT NULL DEFAULT 0,
  not_helpful bigint NOT NULL DEFAULT 0,
  created_by text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kb_articles_tenant ON kb_articles (tenant_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_articles_no ON kb_articles (tenant_id, article_no);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS kb_deflections (
  id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES tenants(id),
  query text,
  article_id bigint REFERENCES kb_articles(id),
  deflected boolean NOT NULL DEFAULT false,
  case_id bigint,
  created_by text,
  created_at timestamptz DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kb_deflections_tenant ON kb_deflections (tenant_id, deflected);
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

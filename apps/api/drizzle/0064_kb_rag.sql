-- Phase D2 — RAG knowledge base (policies/SOPs/contracts). Chunk embeddings are stored as plain
-- number[] (jsonb) so retrieval runs on PGlite without the pgvector extension; cosine is computed
-- in-service. (Prod can migrate `embedding` to a pgvector column + ANN index behind the same API.)
CREATE TABLE IF NOT EXISTS kb_documents (
  id          bigserial PRIMARY KEY,
  tenant_id   bigint REFERENCES tenants(id),
  title       text NOT NULL,
  source      text,
  created_by  text,
  created_at  timestamp DEFAULT now()
);
CREATE TABLE IF NOT EXISTS kb_chunks (
  id          bigserial PRIMARY KEY,
  tenant_id   bigint REFERENCES tenants(id),
  doc_id      bigint REFERENCES kb_documents(id),
  ord         integer NOT NULL,
  content     text NOT NULL,
  embedding   jsonb NOT NULL,
  created_at  timestamp DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kb_documents_tenant ON kb_documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_tenant ON kb_chunks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_kb_chunks_doc ON kb_chunks(doc_id);
--> statement-breakpoint
-- Re-run the dynamic RLS loop so the new tenant_id tables (kb_documents, kb_chunks) are isolated like every other.
DO $$ DECLARE r record; BEGIN
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user';
  EXECUTE 'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO app_user';
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I'
      || ' USING (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)'
      || ' WITH CHECK (coalesce(current_setting(''app.bypass_rls'',true),'''')=''on'''
      || '   OR tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::bigint)', r.table_name);
  END LOOP;
END $$;

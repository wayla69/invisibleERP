-- 0219_kb_embed_provider — semantic-RAG groundwork (docs/24 R4-1, investment-audit finding AUD-AI-01).
-- Each kb_chunks embedding now records WHICH embedding space it lives in (local hashed bag-of-words vs a
-- real semantic provider like Voyage). Vectors from different spaces are not comparable, so retrieval
-- filters to the space the query was embedded in; existing rows are all 'local'. Re-embedding onto a
-- semantic provider = POST /api/ai/kb/reembed after setting EMBED_PROVIDER (+ key).
ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS embed_provider text NOT NULL DEFAULT 'local';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kb_chunks_provider ON kb_chunks (embed_provider);

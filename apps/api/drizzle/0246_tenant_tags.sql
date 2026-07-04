-- Platform Console company tags/segments (god fleet organisation). A free-form string array on tenants —
-- e.g. 'enterprise', 'trial-risk', 'internal' — for filtering/segmenting the company directory in the
-- Platform Console. Platform-level metadata: `tenants` has no tenant_id column, so no RLS loop applies.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]'::jsonb;

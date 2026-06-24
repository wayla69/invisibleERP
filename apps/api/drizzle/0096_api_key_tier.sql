-- 0096 — D1 (Platform Phase 23) API maturity. Adds a rate "tier" to API keys (free | standard | partner).
-- Additive column on the (already RLS-scoped) api_keys table — no new table, no RLS loop.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS tier text DEFAULT 'free';

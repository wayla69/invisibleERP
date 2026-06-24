-- 0094 — E4 (Platform Phase 29) white-label theming. Per-tenant brand theme tokens (brand hue, corner
-- radius, brand name, logo, tagline) applied as CSS variables in the web shell. Additive jsonb column on the
-- (self-RLS-scoped) tenants table — no new table, no RLS loop.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS theme_prefs jsonb DEFAULT '{}'::jsonb;

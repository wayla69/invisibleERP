-- 0093 — C1 (Platform Phase 20) i18n / locale framework. Adds a per-user UI locale override. The effective
-- UI locale resolves user.locale → tenants.default_language → 'th'. Additive column on the (already
-- RLS-scoped) users table — no new table, so no RLS loop needed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale text;

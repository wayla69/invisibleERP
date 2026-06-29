-- 0176 — Per-account login lockout (ITGC-AC-07).
-- login_attempts: a per-username failed-login counter + lockout window. Written via an AUTOCOMMIT connection
--   (not the per-request transaction) so a failed-attempt increment is NOT rolled back when login throws 401
--   — the constraint flagged as the open design item in 0147. Auth-global (pre-tenant) → no tenant_id, no RLS.
CREATE TABLE IF NOT EXISTS login_attempts (
  username      text PRIMARY KEY,           -- normalized (lower) username
  fail_count    integer NOT NULL DEFAULT 0,
  locked_until  timestamptz,                -- when set and in the future, authentication is refused
  last_attempt  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_locked ON login_attempts (locked_until);

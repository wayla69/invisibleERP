-- 0146 — Session revocation (ITGC-AC-15).
-- revoked_tokens: a JWT denylist by jti for explicit single-session logout (a stolen/forwarded token can be
--   killed before its 8h expiry).
-- users.tokens_valid_from: a "revoke ALL sessions" watermark — the guard rejects any JWT issued (iat) before
--   it, so an incident-response "log everyone out" takes effect immediately without a refresh-token rewrite.
--   (Deactivation is also enforced live: the guard re-checks is_active each request, so a disabled account's
--   existing token stops working at once instead of lasting up to 8h.)
-- Both are auth-global (pre-tenant) → no tenant_id, no RLS loop.
-- (Brute-force login lockout is a separate workstream — it needs a write that survives the per-request tx
--  rollback on a 401, which the single-connection test harness can't model without a transaction-model change.)

ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_valid_from timestamptz;

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti text PRIMARY KEY,
  username text,
  expires_at timestamptz NOT NULL,   -- once past, the JWT is dead anyway → row is prunable
  revoked_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_exp ON revoked_tokens (expires_at);

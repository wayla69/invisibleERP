-- 0182_refresh_tokens — refresh-token rotation (ITGC-AC-07).
-- Access JWTs are now short-lived (default 1h, JWT_EXPIRES_IN). A long-lived (default 7d) opaque refresh
-- token, set as an httpOnly cookie, lets the client mint a fresh access token without re-login. Only the
-- sha256 HASH of the opaque token is stored (never the token). One-time use: each refresh rotates the row
-- (rotated_at) and issues a new token; presenting an already-rotated/revoked token is treated as theft and
-- revokes all of that user's refresh tokens. Auth-global (pre-tenant) → no tenant_id, no RLS loop.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id bigserial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  username text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now(),
  rotated_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (username);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_exp ON refresh_tokens (expires_at);

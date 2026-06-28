-- 0177 — SSO login-flow state (OIDC CSRF / replay / nonce / PKCE).
-- sso_login_state: one row per /sso/authorize call. The /sso/callback must present a matching `state` that
--   is unconsumed and unexpired (single-use) — closing the login-CSRF / account-fixation gap where `state`
--   was issued but never verified. `nonce` is bound into the id_token (replay defence); `code_verifier` is
--   the PKCE secret for the auth-code → token exchange. Auth-global, short-lived → no tenant_id, no RLS.
CREATE TABLE IF NOT EXISTS sso_login_state (
  state         text PRIMARY KEY,
  tenant_code   text NOT NULL,
  nonce         text NOT NULL,
  code_verifier text,
  created_at    timestamptz DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_sso_login_state_exp ON sso_login_state (expires_at);

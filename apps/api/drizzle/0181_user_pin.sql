-- 0181_user_pin — POS-PIN quick-login (ITGC-AC-17).
-- Per-user PIN for fast front-of-house sign-in (cashier/server). Hashed with the SAME scrypt KDF as the
-- password (never stored in clear); nullable + opt-in. Restricted to non-privileged roles at the service
-- layer (a role requiring MFA can neither set nor use a PIN). Shares the ITGC-AC-07 login lockout, so a
-- PIN brute-force trips the same per-account throttle. `pin_set_at` records the last rotation for audit.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_set_at timestamptz;

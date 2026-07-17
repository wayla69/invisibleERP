import { pgTable, bigserial, bigint, integer, text, timestamp, boolean, primaryKey } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { roleEnum } from './enums';

export { roleEnum };

// จาก tbl_users (dual SQLite/PG เดิม) — normalize casing ครั้งเดียว
export const users = pgTable('users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(), // scrypt, optionally peppered (scrypt-p1$…, PASSWORD_PEPPER); param-less legacy scrypt is rehashed on login. Bare unsalted-SHA-256 is REJECTED (never accepted) and scrubbed by 0428.
  role: roleEnum('role').notNull().default('Sales'), // เดิม PG default 'Staff' (bug) → แก้เป็น Sales
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  // ── Hybrid tenancy (0196) — the HQ "org" an Admin belongs to. Under TENANCY_MODE=multi-company the
  // Admin's RLS bypass is scoped to tenants sharing this org_id. NULL = legacy global-HQ behavior. ──
  orgId: bigint('org_id', { mode: 'number' }),
  mustChangePassword: boolean('must_change_password').default(false), // A5 — force rotate default/weak password
  pinHash: text('pin_hash'), // POS-PIN — scrypt-hashed 4–6 digit quick-login PIN (opt-in; non-privileged front-of-house roles only). Privileged/MFA roles are blocked from PIN auth.
  pinSetAt: timestamp('pin_set_at', { withTimezone: true }), // when the PIN was last set/rotated (audit)
  mfaEnabled: boolean('mfa_enabled').default(false), // move #7 — TOTP
  totpSecret: text('totp_secret'),
  ssoSubject: text('sso_subject'), // OIDC/SAML subject for SSO users
  isActive: boolean('is_active').notNull().default(true), // SCIM deprovisioning deactivates (no hard delete)
  tokensValidFrom: timestamp('tokens_valid_from', { withTimezone: true }), // ITGC-AC-15: JWTs issued before this are rejected ("revoke all sessions")
  locale: text('locale'), // C1 (Phase 20) — per-user UI locale override; resolves user → tenant.default_language → 'th'
  // ── LINE chat → PR (0227) — staff LINE identity link. lineUserId is the stable LINE userId (unique
  // across users); the short-lived link code is generated on /requisitions and typed into the LINE OA chat.
  lineUserId: text('line_user_id'),
  lineLinkCode: text('line_link_code'),
  lineLinkExpiresAt: timestamp('line_link_expires_at', { withTimezone: true }),
  // ── Email-to-Capture (0245, docs/34 Phase 4) — staff verified "send-from" address for bill forwarding.
  // A bill emailed to the tenant capture inbox from this address is attributed to this user + gated on
  // pr_raise. captureEmail set + captureEmailCode NULL ⇒ verified; code present ⇒ pending a mailed code.
  captureEmail: text('capture_email'),
  captureEmailCode: text('capture_email_code'),
  captureEmailExpiresAt: timestamp('capture_email_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ITGC-AC-15 — JWT denylist by jti for explicit single-session logout (kills a token before its expiry).
export const revokedTokens = pgTable('revoked_tokens', {
  jti: text('jti').primaryKey(),
  username: text('username'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }).defaultNow(),
});

// ITGC-AC-07 — refresh-token rotation. Access JWTs are now short-lived (1h); a long-lived (default 7d)
// opaque refresh token lets the client mint a fresh access token without re-login. Only the sha256 HASH of
// the opaque token is stored (never the token). One-time use: each refresh ROTATES (marks rotated_at and
// issues a new token); presenting an already-rotated/revoked token is treated as theft → all the user's
// refresh tokens are revoked. Auth-global (pre-tenant) → no tenant_id, no RLS.
export const refreshTokens = pgTable('refresh_tokens', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tokenHash: text('token_hash').notNull().unique(), // sha256(opaque token)
  username: text('username').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }), // set when consumed (one-time use)
  revokedAt: timestamp('revoked_at', { withTimezone: true }), // set on logout / reuse-detection
});

// ITGC-AC-07 — per-account login throttle/lockout. Keyed by normalized (lower) username. Written via an
// AUTOCOMMIT path (not the per-request tx) so a failed-login increment survives the 401's tx rollback.
// Auth-global (pre-tenant) → no tenant_id, no RLS.
export const loginAttempts = pgTable('login_attempts', {
  username: text('username').primaryKey(),
  failCount: integer('fail_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastAttempt: timestamp('last_attempt', { withTimezone: true }).defaultNow(),
});

// SSO login-flow state (CSRF/replay protection for the OIDC handshake). One row per authorize() call; the
// callback must present a matching, unconsumed, unexpired `state`. Carries the OIDC `nonce` (bound into the
// id_token) and the PKCE `code_verifier`. Auth-global (pre-tenant, short-lived) → no tenant_id, no RLS.
export const ssoLoginState = pgTable('sso_login_state', {
  state: text('state').primaryKey(),
  tenantCode: text('tenant_code').notNull(),
  nonce: text('nonce').notNull(),
  codeVerifier: text('code_verifier'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

// แทน Permissions CSV (de-serialized)
export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  emoji: text('emoji'),
  labelTh: text('label_th'),
  labelEn: text('label_en'),
  grp: text('grp'),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    role: roleEnum('role').notNull(),
    perm: text('perm').notNull().references(() => permissions.key),
  },
  (t) => ({ pk: primaryKey({ columns: [t.role, t.perm] }) }),
);

export const userPermissions = pgTable(
  'user_permissions',
  {
    userId: bigint('user_id', { mode: 'number' }).notNull().references(() => users.id),
    perm: text('perm').notNull().references(() => permissions.key),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.perm] }) }),
);

export type User = typeof users.$inferSelect;

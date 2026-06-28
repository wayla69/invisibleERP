import { pgTable, bigserial, bigint, integer, text, timestamp, boolean, primaryKey } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { roleEnum } from './enums';

export { roleEnum };

// จาก tbl_users (dual SQLite/PG เดิม) — normalize casing ครั้งเดียว
export const users = pgTable('users', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(), // argon2/scrypt; legacy sha256 verified+rehashed on login
  role: roleEnum('role').notNull().default('Sales'), // เดิม PG default 'Staff' (bug) → แก้เป็น Sales
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  mustChangePassword: boolean('must_change_password').default(false), // A5 — force rotate default/weak password
  mfaEnabled: boolean('mfa_enabled').default(false), // move #7 — TOTP
  totpSecret: text('totp_secret'),
  ssoSubject: text('sso_subject'), // OIDC/SAML subject for SSO users
  isActive: boolean('is_active').notNull().default(true), // SCIM deprovisioning deactivates (no hard delete)
  tokensValidFrom: timestamp('tokens_valid_from', { withTimezone: true }), // ITGC-AC-15: JWTs issued before this are rejected ("revoke all sessions")
  locale: text('locale'), // C1 (Phase 20) — per-user UI locale override; resolves user → tenant.default_language → 'th'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ITGC-AC-15 — JWT denylist by jti for explicit single-session logout (kills a token before its expiry).
export const revokedTokens = pgTable('revoked_tokens', {
  jti: text('jti').primaryKey(),
  username: text('username'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }).defaultNow(),
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

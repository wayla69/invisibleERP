import { pgTable, bigserial, bigint, text, timestamp, boolean, primaryKey } from 'drizzle-orm/pg-core';
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

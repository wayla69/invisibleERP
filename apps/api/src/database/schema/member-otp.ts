// CRM Phase 4 — phone-OTP login for the member self-service app. A short-lived, hashed one-time code per
// member; verified to mint a member JWT (role 'Member', permissions []). tenant_id REQUIRED. The OTP code is
// stored HASHED (scrypt, same as passwords) — never in plaintext. Brute-force-bounded by attempts + expiry.
import { pgTable, bigserial, bigint, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';

export const memberOtps = pgTable('member_otps', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ idxMember: index('member_otps_member').on(t.memberId), idxTenant: index('member_otps_tenant').on(t.tenantId, t.createdAt) }));

export type MemberOtp = typeof memberOtps.$inferSelect;

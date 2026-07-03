import { pgTable, bigserial, bigint, text, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Invite-link onboarding (ITGC-AC-18 #2). Platform-level (pre-tenant, no tenant_id → no RLS, like `plans`).
// A platform owner issues a single-use, expiring invite; the public signup endpoint accepts a valid token
// to provision ONE company even when public signup is disabled. Only the token HASH is stored.
export const signupInvites = pgTable('signup_invites', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: text('created_by').notNull(),
  companyName: text('company_name'),
  planCode: text('plan_code'),
  email: text('email'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedTenantId: bigint('used_tenant_id', { mode: 'number' }).references(() => tenants.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

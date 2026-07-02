import { pgTable, bigserial, bigint, text, integer, numeric, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';

// V5 (docs/29) — digital wallet-pass registry (Apple/Google; mock until the signing creds exist). One row
// per member×platform (unique) — a re-issue returns the same registration, never a duplicate. The BiLive
// loyalty tick bumps updates_count / last_points so the pass surface tracks the live balance (best-effort,
// never a control). PDPA: a pass carries shop/member_code/name/tier/points ONLY; this table stores less.
export const walletPassRegistrations = pgTable('wallet_pass_registrations', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).notNull().references(() => posMembers.id),
  platform: text('platform').notNull(),   // requested: 'apple' | 'google'
  provider: text('provider').notNull(),   // what actually issued: 'apple' | 'google' | 'mock'
  passSerial: text('pass_serial').notNull(),
  pushToken: text('push_token'),          // Apple APNs pass-update token (device registers it later; null until then)
  status: text('status').notNull().default('Active'),
  updatesCount: integer('updates_count').notNull().default(0), // pass refreshes recorded off the loyalty tick
  lastPoints: numeric('last_points'),
  lastTier: text('last_tier'),
  lastUpdateAt: timestamp('last_update_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  createdBy: text('created_by'),
}, (t) => ({
  uqMemberPlatform: uniqueIndex('wallet_pass_member_platform').on(t.memberId, t.platform),
  tenantIdx: index('wallet_pass_tenant').on(t.tenantId, t.memberId),
}));

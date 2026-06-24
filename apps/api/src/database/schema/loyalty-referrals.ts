// CRM Phase 4 — member-get-member referrals. A member refers another (an existing member, or a phone to
// link later); when the referral is rewarded, both sides get bonus points (a pos_member_ledger 'Adjust'
// row, which the liability accrual then books). tenant_id REQUIRED → RLS. A member can be referred once
// (partial unique on referred_member_id). Status is text (Zod-validated): pending | rewarded | void.
import { pgTable, bigserial, bigint, text, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';

export const loyaltyReferrals = pgTable('loyalty_referrals', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  referrerMemberId: bigint('referrer_member_id', { mode: 'number' }).references(() => posMembers.id),
  referredMemberId: bigint('referred_member_id', { mode: 'number' }).references(() => posMembers.id), // null until enrolled
  referredPhone: text('referred_phone'),
  code: text('code').notNull().unique(),                  // RFL-YYYYMMDD-NNN
  status: text('status').notNull().default('pending'),    // pending | rewarded | void
  referrerPoints: integer('referrer_points').notNull().default(0),
  referredPoints: integer('referred_points').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  rewardedAt: timestamp('rewarded_at', { withTimezone: true }),
  createdBy: text('created_by'),
}, (t) => ({
  idxReferrer: index('loyalty_referrals_referrer').on(t.referrerMemberId),
  // a member can be referred at most once (anti-gaming) — partial unique defined in the migration SQL.
}));

export type LoyaltyReferral = typeof loyaltyReferrals.$inferSelect;

// CRM Phase 2 — Rewards catalog, point-burn redemptions (single-use codes), and the member coupon wallet.
// A reward redemption burns points (a pos_member_ledger 'Redeem' row) → the Phase-1.5 liability accrual
// releases the matching 2250/5700. Redemption/coupon codes are single-use with a one-way status lifecycle
// (mirrors the gift-card pattern). tenant_id REQUIRED → RLS. Status/type columns are text (Zod-validated).
import { pgTable, bigserial, bigint, text, numeric, integer, timestamp, date, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';

export const loyaltyRewards = pgTable('loyalty_rewards', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  rewardCode: text('reward_code').notNull(),                 // RWD-… (unique per tenant)
  name: text('name').notNull(),
  type: text('type').notNull().default('evoucher'),          // evoucher | discount | product | privilege
  pointCost: numeric('point_cost').notNull(),                // points burned to redeem
  cashValue: numeric('cash_value', { precision: 14, scale: 2 }).default('0'), // THB face/fair value (reference)
  couponKind: text('coupon_kind'),                           // percent | amount | free_item (coupon this reward issues)
  couponValue: numeric('coupon_value', { precision: 14, scale: 2 }).default('0'),
  stock: integer('stock'),                                   // null = unlimited
  perMemberLimit: integer('per_member_limit'),               // null = unlimited
  tierMin: numeric('tier_min'),                              // min lifetime points to be eligible (null = any)
  validFrom: date('valid_from'),
  validTo: date('valid_to'),
  imageKey: text('image_key'),
  active: boolean('active').default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqCode: uniqueIndex('loyalty_rewards_tenant_code').on(t.tenantId, t.rewardCode) }));

// Member burned points for a reward → a single-use redemption code. Append-only-ish: status is one-way
// (issued → used | expired | void). The point burn itself lives in pos_member_ledger (the sub-ledger).
export const loyaltyRedemptions = pgTable('loyalty_redemptions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  rewardId: bigint('reward_id', { mode: 'number' }).references(() => loyaltyRewards.id),
  redemptionCode: text('redemption_code').notNull().unique(), // RDM-YYYYMMDD-NNN (scannable / single-use)
  pointCost: numeric('point_cost').notNull(),                // points burned (snapshot)
  rewardName: text('reward_name'),                           // snapshot
  rewardType: text('reward_type'),                           // snapshot
  value: numeric('value', { precision: 14, scale: 2 }).default('0'), // face value snapshot
  status: text('status').notNull().default('issued'),        // issued | used | expired | void
  issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedRef: text('used_ref'),                                 // sale_no where applied
  createdBy: text('created_by'),
}, (t) => ({ idxMember: index('loyalty_redemptions_member').on(t.memberId), idxStatus: index('loyalty_redemptions_tenant_status').on(t.tenantId, t.status) }));

// Member coupon wallet — discount codes issued WITHOUT burning points (campaign / birthday / referral /
// manual / from a reward). Single-use; one-way status (active → used | expired).
export const memberCoupons = pgTable('member_coupons', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  code: text('code').notNull().unique(),                     // CPN-YYYYMMDD-NNN
  kind: text('kind').notNull(),                              // percent | amount | free_item
  value: numeric('value', { precision: 14, scale: 2 }).default('0'),
  source: text('source'),                                    // campaign | birthday | referral | manual | reward
  status: text('status').notNull().default('active'),        // active | used | expired
  issuedAt: timestamp('issued_at', { withTimezone: true }).defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedRef: text('used_ref'),
  createdBy: text('created_by'),
}, (t) => ({ idxMember: index('member_coupons_member').on(t.memberId), idxStatus: index('member_coupons_tenant_status').on(t.tenantId, t.status) }));

export type LoyaltyReward = typeof loyaltyRewards.$inferSelect;
export type LoyaltyRedemption = typeof loyaltyRedemptions.$inferSelect;
export type MemberCoupon = typeof memberCoupons.$inferSelect;

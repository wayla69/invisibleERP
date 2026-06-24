// CRM Phase 3 — gamification (missions / stamp cards) + tier-change history.
// Missions: a member accrues progress toward a goal; on completion they claim a reward (bonus points or a
// coupon). Tier history: an audit row each time a member's tier changes (auto-recompute / manual).
// tenant_id REQUIRED → RLS. Status/type/reason columns are text (Zod-validated at the API).
import { pgTable, bigserial, bigint, text, numeric, integer, timestamp, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';

// Audit of every tier change (member moved up/down a loyalty tier).
export const loyaltyTierHistory = pgTable('loyalty_tier_history', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  fromTier: text('from_tier'),
  toTier: text('to_tier').notNull(),
  reason: text('reason'),                                 // recompute | manual | decay
  lifetime: numeric('lifetime'),                          // lifetime points at the change
  effectiveAt: timestamp('effective_at', { withTimezone: true }).defaultNow(),
  createdBy: text('created_by'),
}, (t) => ({ idxMember: index('loyalty_tier_history_member').on(t.memberId) }));

// A gamification mission / stamp card.
export const loyaltyMissions = pgTable('loyalty_missions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  missionCode: text('mission_code').notNull(),            // MSN-… (unique per tenant)
  name: text('name').notNull(),
  type: text('type').notNull().default('stamp'),          // stamp | quest
  goal: integer('goal').notNull().default(1),             // stamps / steps to complete
  rewardKind: text('reward_kind').notNull().default('points'), // points | coupon
  rewardPoints: integer('reward_points').default(0),      // bonus points granted (reward_kind=points)
  rewardCouponKind: text('reward_coupon_kind'),           // percent | amount | free_item (reward_kind=coupon)
  rewardCouponValue: numeric('reward_coupon_value', { precision: 14, scale: 2 }).default('0'),
  period: text('period'),                                 // once | monthly | null (informational)
  active: boolean('active').default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqCode: uniqueIndex('loyalty_missions_tenant_code').on(t.tenantId, t.missionCode) }));

// Per-member progress toward a mission. One row per (member, mission).
export const loyaltyMissionProgress = pgTable('loyalty_mission_progress', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  missionId: bigint('mission_id', { mode: 'number' }).references(() => loyaltyMissions.id),
  progress: integer('progress').notNull().default(0),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqMemberMission: uniqueIndex('loyalty_mission_progress_member_mission').on(t.memberId, t.missionId) }));

export type LoyaltyTierHistory = typeof loyaltyTierHistory.$inferSelect;
export type LoyaltyMission = typeof loyaltyMissions.$inferSelect;
export type LoyaltyMissionProgress = typeof loyaltyMissionProgress.$inferSelect;

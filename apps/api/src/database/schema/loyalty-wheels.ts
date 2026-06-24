// CRM Phase 4 — spin-the-wheel / lucky draw. A wheel has weighted prize segments; a member spends points (or
// a daily free spin) to spin, and a server-side crypto-weighted RNG picks ONE segment. Each spin is an audit
// row (provably-fair: the segments + weights are stored and the outcome is recorded). Prizes reuse the points
// ledger ('Adjust') and the coupon wallet. tenant_id REQUIRED → RLS.
import { pgTable, bigserial, bigint, text, numeric, integer, timestamp, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';

export const loyaltyWheels = pgTable('loyalty_wheels', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  wheelCode: text('wheel_code').notNull(),                 // WHL-… (unique per tenant)
  name: text('name').notNull(),
  costPoints: integer('cost_points').notNull().default(0), // points to spin (0 = free)
  dailyFreeSpins: integer('daily_free_spins').notNull().default(0), // free spins/member/day before cost applies
  active: boolean('active').default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqCode: uniqueIndex('loyalty_wheels_tenant_code').on(t.tenantId, t.wheelCode) }));

// A prize segment on a wheel. Selection probability = weight / sum(weight) over segments with stock left.
export const loyaltyWheelSegments = pgTable('loyalty_wheel_segments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  wheelId: bigint('wheel_id', { mode: 'number' }).references(() => loyaltyWheels.id),
  label: text('label').notNull(),
  prizeKind: text('prize_kind').notNull().default('none'), // points | coupon | none
  prizePoints: integer('prize_points').default(0),
  couponKind: text('coupon_kind'),                         // percent | amount | free_item
  couponValue: numeric('coupon_value', { precision: 14, scale: 2 }).default('0'),
  weight: integer('weight').notNull().default(1),          // relative probability (>=0)
  stock: integer('stock'),                                 // null = unlimited; else remaining prizes
  wonCount: integer('won_count').notNull().default(0),
  sort: integer('sort').notNull().default(0),
}, (t) => ({ idxWheel: index('loyalty_wheel_segments_wheel').on(t.wheelId) }));

// Audit of every spin: which segment was won, the cost paid, and when.
export const loyaltySpins = pgTable('loyalty_spins', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  wheelId: bigint('wheel_id', { mode: 'number' }).references(() => loyaltyWheels.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  segmentId: bigint('segment_id', { mode: 'number' }).references(() => loyaltyWheelSegments.id),
  spinCode: text('spin_code').notNull(),                   // SPN-…
  prizeKind: text('prize_kind').notNull(),
  prizePoints: integer('prize_points').default(0),
  costPoints: integer('cost_points').default(0),
  free: boolean('free').default(false),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ idxMember: index('loyalty_spins_member').on(t.memberId, t.createdAt), idxTenant: index('loyalty_spins_tenant').on(t.tenantId, t.createdAt) }));

export type LoyaltyWheel = typeof loyaltyWheels.$inferSelect;
export type LoyaltyWheelSegment = typeof loyaltyWheelSegments.$inferSelect;
export type LoyaltySpin = typeof loyaltySpins.$inferSelect;

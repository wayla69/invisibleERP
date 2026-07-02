// V4 (docs/29, control LYL-21) — paid VIP membership: a recurring club fee, deferred (2410) and
// recognized monthly (4300), granting the plan's tier until it lapses. One ACTIVE membership per member.
import { pgTable, bigserial, bigint, text, numeric, integer, timestamp, date, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';

export const membershipPlans = pgTable('membership_plans', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  tier: text('tier').notNull(),
  price: numeric('price', { precision: 14, scale: 2 }).notNull(),
  periodMonths: integer('period_months').notNull().default(12),
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqCode: uniqueIndex('membership_plans_tenant_code').on(t.tenantId, t.code),
  idxTenant: index('membership_plans_tenant').on(t.tenantId),
}));

export const memberMemberships = pgTable('member_memberships', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).notNull().references(() => posMembers.id),
  planId: bigint('plan_id', { mode: 'number' }).notNull().references(() => membershipPlans.id),
  status: text('status').notNull().default('Active'),
  startDate: date('start_date').notNull(),
  endDate: date('end_date').notNull(),
  price: numeric('price', { precision: 14, scale: 2 }).notNull(),
  periodMonths: integer('period_months').notNull(),
  recognizedMonths: integer('recognized_months').notNull().default(0),
  saleRef: text('sale_ref'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqActive: uniqueIndex('member_memberships_one_active').on(t.memberId).where(sql`${t.status} = 'Active'`),
  idxTenant: index('member_memberships_tenant').on(t.tenantId, t.status),
}));

export type MembershipPlan = typeof membershipPlans.$inferSelect;
export type MemberMembership = typeof memberMemberships.$inferSelect;

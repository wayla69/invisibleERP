import { pgTable, bigserial, bigint, text, numeric, timestamp, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Self-serve tenant lifecycle + subscription billing (move #6)
export const subStatusEnum = pgEnum('sub_status', ['Trialing', 'Active', 'PastDue', 'Canceled']);

export const plans = pgTable('plans', {
  code: text('code').primaryKey(), // 'free' | 'starter' | 'pro' | 'enterprise'
  name: text('name').notNull(),
  priceMonthly: numeric('price_monthly', { precision: 12, scale: 2 }).default('0'),
  currency: text('currency').default('THB'),
  features: jsonb('features'),
  active: text('active').default('true'),
});

export const subscriptions = pgTable('subscriptions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  planCode: text('plan_code').notNull().references(() => plans.code),
  status: subStatusEnum('status').default('Trialing'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type Subscription = typeof subscriptions.$inferSelect;

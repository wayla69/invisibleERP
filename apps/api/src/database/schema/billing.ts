import { pgTable, bigserial, bigint, integer, text, numeric, timestamp, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Self-serve tenant lifecycle + subscription billing (move #6)
export const subStatusEnum = pgEnum('sub_status', ['Trialing', 'Active', 'PastDue', 'Canceled']);

export const plans = pgTable('plans', {
  code: text('code').primaryKey(), // 'free' | 'starter' | 'pro' | 'enterprise'
  name: text('name').notNull(),
  priceMonthly: numeric('price_monthly', { precision: 12, scale: 2 }).default('0'),
  // 1.7 — annual billing: the per-year price (NULL = the plan is not offered annually). Seeded at 10×
  // monthly (2 months free) — a market-entry default, tune after testing.
  priceYearly: numeric('price_yearly', { precision: 12, scale: 2 }),
  currency: text('currency').default('THB'),
  // 1.7 — multi-currency price list: { "USD": { "monthly": 55, "yearly": 550 } }. NULL = THB only;
  // a currency absent from the map is NOT offered (checkout fails closed CURRENCY_NOT_OFFERED).
  prices: jsonb('prices'),
  features: jsonb('features'),
  active: text('active').default('true'),
});

export const subscriptions = pgTable('subscriptions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  planCode: text('plan_code').notNull().references(() => plans.code),
  status: subStatusEnum('status').default('Trialing'),
  billingInterval: text('billing_interval').default('monthly'), // 1.7 — 'monthly' | 'annual' (default = legacy behaviour)
  currency: text('currency').default('THB'),                    // 1.7 — the currency this subscription is billed in
  // 0451 — purchased à-la-carte add-on suite keys (ADDON_KEYS in @ierp/shared); unioned into the
  // tenant's entitled suites by resolveEntitledSuites. NULL = none.
  addons: jsonb('addons'),
  // 0454 — price grandfathering (docs/53 Q7): the plan price snapshotted at subscribe/plan-change time.
  // Charge paths read COALESCE(snapshot, plans.price_*), so a later PLAN_SEED repricing never re-prices
  // an existing subscription. grandfathered_until NULL = indefinite lock (cleared by plan change or an
  // explicit platform-admin re-price at contractual renewal).
  grandfatheredPrice: numeric('grandfathered_price'),
  grandfatheredAnnualPrice: numeric('grandfathered_annual_price'),
  grandfatheredUntil: timestamp('grandfathered_until'),
  // 0455 — POS-line per-branch billing quantity (plans with features.per_branch). NULL = 1.
  branches: integer('branches'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type Subscription = typeof subscriptions.$inferSelect;

// LINE marketing automation — closed-loop campaigns. A campaign targets a behaviour trigger
// (lapsed / birthday / win-back), pushes a per-member coupon over LINE, and tracks the redemption back
// to the sale so marketing spend is attributable. tenant_id REQUIRED → RLS (each shop owns its roster).
import { pgTable, bigserial, bigint, text, numeric, integer, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';

export const automationCampaigns = pgTable('automation_campaigns', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  name: text('name').notNull(),
  trigger: text('trigger').notNull(),                  // lapsed | birthday | winback | all
  channel: text('channel').notNull().default('line'),  // line | sms | email
  couponPrefix: text('coupon_prefix'),                 // coupon code prefix, e.g. WINBACK
  discountType: text('discount_type'),                 // amount | percent
  discountValue: numeric('discount_value', { precision: 14, scale: 2 }).default('0'),
  // A/B + holdout (Phase G2, docs/25): a deterministic (campaign_id, member_id) hash buckets each member —
  // holdout gets NO message/coupon (the baseline), B gets variant_b_body, the rest get the default body.
  variantBBody: text('variant_b_body'),                // message body for the B group (null = no A/B)
  splitBPct: integer('split_b_pct').notNull().default(0),   // % of audience assigned to B
  holdoutPct: integer('holdout_pct').notNull().default(0),  // % held out (no send — the control group)
  status: text('status').notNull().default('sent'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const campaignSends = pgTable('campaign_sends', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  campaignId: bigint('campaign_id', { mode: 'number' }).references(() => automationCampaigns.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  couponCode: text('coupon_code'),                     // unique per tenant — the redemption key
  channel: text('channel'),
  recipient: text('recipient'),
  status: text('status').notNull(),                    // sent | failed | skipped | holdout
  variant: text('variant'),                            // A | B | holdout (G2 assignment, deterministic)
  error: text('error'),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow(),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  redeemedSaleNo: text('redeemed_sale_no'),
  redeemedValue: numeric('redeemed_value', { precision: 14, scale: 2 }),
  createdBy: text('created_by'),
}, (t) => ({ uqCoupon: uniqueIndex('campaign_sends_tenant_coupon').on(t.tenantId, t.couponCode) }));

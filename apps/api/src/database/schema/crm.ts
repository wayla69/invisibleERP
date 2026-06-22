// CRM: per-member aggregated profiles (RFM) + personalized promo audience rules.
// Refreshed on-demand by CrmService.refreshProfile(); used by AI-powered personalization.
import { pgTable, bigserial, bigint, numeric, text, integer, jsonb, timestamp, boolean } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';
import { promotions } from './marketing';

// Aggregated customer view — one row per (tenant, member). Upserted after each order + on-demand.
export const customerProfiles = pgTable('customer_profiles', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  totalOrders: integer('total_orders').notNull().default(0),
  totalSpend: numeric('total_spend', { precision: 14, scale: 2 }).notNull().default('0'),
  lastOrderAt: timestamp('last_order_at', { withTimezone: true }),
  firstOrderAt: timestamp('first_order_at', { withTimezone: true }),
  rfmRecency: integer('rfm_recency'),        // days since last order
  rfmFrequency: integer('rfm_frequency'),    // order count in last 90d
  rfmMonetary: numeric('rfm_monetary', { precision: 14, scale: 2 }), // spend in last 90d
  rfmSegment: text('rfm_segment'),           // Champions|Loyal|At Risk|Lost|New
  preferredChannel: text('preferred_channel'), // dine_in|delivery|online|kiosk
  favoriteItemIds: jsonb('favorite_item_ids'), // top 3 item ids
  visitCount: integer('visit_count').notNull().default(0),
  avgOrderValue: numeric('avg_order_value', { precision: 14, scale: 2 }),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).defaultNow(),
});

// Links a promotion to a target audience segment — the AI personalization layer.
// When a member's rfmSegment / lifetime / frequency matches any active rule for a promo,
// that promo is surfaced in personalizedPromos().
export const promoAudienceRules = pgTable('promo_audience_rules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  promoId: bigint('promo_id', { mode: 'number' }).references(() => promotions.id),
  rfmSegment: text('rfm_segment'),            // target segment; null = any
  minLifetime: numeric('min_lifetime', { precision: 14, scale: 2 }), // min lifetime points
  minFrequency: integer('min_frequency'),     // min orders in last 90d
  preferredChannel: text('preferred_channel'), // restrict to channel; null = any
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type CustomerProfile = typeof customerProfiles.$inferSelect;
export type PromoAudienceRule = typeof promoAudienceRules.$inferSelect;

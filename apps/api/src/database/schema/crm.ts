// CRM: per-member aggregated profiles (RFM) + personalized promo audience rules.
// Refreshed on-demand by CrmService.refreshProfile(); used by AI-powered personalization.
import { pgTable, bigserial, bigint, numeric, text, integer, jsonb, timestamp, boolean } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';
import { promotions } from './marketing';

// Saved custom segments (Phase D1) — a reusable, tenant-defined "audience" beyond the fixed RFM buckets:
// a named set of rules (field/op/value) over member + profile fields, combined with all/any. Resolved to the
// matching members on demand by SavedSegmentsService (whitelisted field→column map; bound values). RLS.
export const savedSegments = pgTable('saved_segments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  name: text('name').notNull(),
  matchMode: text('match_mode').notNull().default('all'), // 'all' (AND) | 'any' (OR)
  rules: jsonb('rules').notNull().default('[]'),           // [{ field, op, value }]
  createdBy: text('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

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
  rfmSegment: text('rfm_segment'),           // Champions|Loyal|At Risk|Lost|New (ERP's own RFM — CrmService owns)
  // Advanced RFM segment pushed by the external Marketing Intelligence platform (migration 0460). A SEPARATE
  // column from rfmSegment so the two engines never clobber each other; campaigns target it via `mi_segment`.
  miRfmSegment: text('mi_rfm_segment'),
  // Customer Intelligence (docs/60 Phase 2, migration 0464) — per-customer scores the external platform
  // computes (CLV / churn / next-best-action) and PUSHES in. SEPARATE from the ERP's own explainable
  // churnRisk / predictedLtv below, mirroring how miRfmSegment stays distinct from rfmSegment. Advisory.
  miClv: numeric('mi_clv', { precision: 14, scale: 2 }),      // platform predicted 12-month CLV (฿)
  miChurnRisk: numeric('mi_churn_risk', { precision: 5, scale: 4 }), // platform churn probability [0,1]
  miNba: text('mi_nba'),                                       // next-best-action code (WINBACK|UPSELL|VIP_CARE|REACTIVATE|…)
  preferredChannel: text('preferred_channel'), // dine_in|delivery|online|kiosk
  favoriteItemIds: jsonb('favorite_item_ids'), // top 3 item ids
  visitCount: integer('visit_count').notNull().default(0),
  avgOrderValue: numeric('avg_order_value', { precision: 14, scale: 2 }),
  // Predictive scoring (Growth Engine G3, docs/25) — EXPLAINABLE versioned weighted formula, not a model:
  // computed inside refreshProfile alongside RFM (one reviewed path). Null until the member has ≥1 order.
  churnRisk: integer('churn_risk'),                                  // 0..100 (docs/ops/predictive-scoring.md)
  predictedLtv: numeric('predicted_ltv', { precision: 14, scale: 2 }), // ฿, 12-month estimate
  scoreVersion: text('score_version'),                               // formula version stamp (e.g. 'v2')
  preferredHour: integer('preferred_hour'),                          // H3: 0-23 Asia/Bangkok — histogram mode of paid-order hours; null <3 orders
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

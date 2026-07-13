// docs/47 — external reputation & analytics ingestion (Google Maps reviews, GA4). A distinct bounded
// context from marketing (campaigns/segments) and connectors (canonical order/product/statement import):
// this is scheduled-poll ingestion of third-party review + analytics data, no inbound webhook exists for
// either platform. OAuth tokens are stored via the transparent `encryptedText` column type (AES-256-GCM,
// common/crypto.ts) — never returned by any read endpoint.
import { pgTable, bigserial, bigint, text, integer, numeric, jsonb, timestamp, date, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { encryptedText } from '../encrypted-column';

// One row per (tenant, platform) — the OAuth grant + which locations/properties are tracked.
export const reputationConnections = pgTable('reputation_connections', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  platform: text('platform').notNull(),                 // google_maps | google_analytics
  status: text('status').notNull().default('active'),   // active | error | revoked
  googleAccountEmail: text('google_account_email'),
  accessTokenEnc: encryptedText('access_token_enc'),
  refreshTokenEnc: encryptedText('refresh_token_enc'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  // Chosen Business-Profile location resource names / GA4 property ids: [{ ref, label }]
  externalRefs: jsonb('external_refs').notNull().default([]),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqPlatform: uniqueIndex('reputation_connections_tenant_platform').on(t.tenantId, t.platform),
}));

// Single-use OAuth state (mirrors sso_login_state) — created at /oauth/start, consumed at /oauth/callback.
export const reputationOauthState = pgTable('reputation_oauth_state', {
  state: text('state').primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  createdBy: text('created_by').notNull(),
  platform: text('platform').notNull(),
  codeVerifier: text('code_verifier').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, (t) => ({
  idxTenant: index('reputation_oauth_state_tenant').on(t.tenantId),
}));

// Synced Google Maps (Business Profile) reviews. Reviewer name/photo are public data the reviewer already
// posted to Google Maps — not first-party consent-gated PII (distinct from the G3 audience-export control).
export const externalReviews = pgTable('external_reviews', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  platform: text('platform').notNull(),
  locationRef: text('location_ref').notNull(),
  externalReviewId: text('external_review_id').notNull(),
  authorName: text('author_name'),
  authorPhotoUrl: text('author_photo_url'),
  rating: integer('rating'),
  comment: text('comment'),
  reviewCreateTime: timestamp('review_create_time', { withTimezone: true }),
  reviewUpdateTime: timestamp('review_update_time', { withTimezone: true }),
  replyComment: text('reply_comment'),
  replyUpdateTime: timestamp('reply_update_time', { withTimezone: true }),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqReview: uniqueIndex('external_reviews_tenant_platform_id').on(t.tenantId, t.platform, t.externalReviewId),
  idxAttention: index('external_reviews_tenant_rating').on(t.tenantId, t.rating),
}));

// Synced GA4 daily metrics per property.
export const analyticsDailySnapshots = pgTable('analytics_daily_snapshots', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  propertyRef: text('property_ref').notNull(),
  metricDate: date('metric_date').notNull(),
  sessions: integer('sessions').default(0),
  activeUsers: integer('active_users').default(0),
  conversions: integer('conversions').default(0),
  totalRevenue: numeric('total_revenue', { precision: 14, scale: 2 }).default('0'),
  engagementRate: numeric('engagement_rate', { precision: 6, scale: 4 }),
  topChannelGroup: text('top_channel_group'),
  raw: jsonb('raw').default({}),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uqSnapshot: uniqueIndex('analytics_snapshots_tenant_property_date').on(t.tenantId, t.propertyRef, t.metricDate),
}));

export type ReputationConnection = typeof reputationConnections.$inferSelect;
export type ExternalReview = typeof externalReviews.$inferSelect;
export type AnalyticsDailySnapshot = typeof analyticsDailySnapshots.$inferSelect;

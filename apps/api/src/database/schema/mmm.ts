// docs/48 — Marketing Mix Modeling (MMM). A distinct bounded context from marketing (campaigns/segments),
// reputation (external review/GA4 ingestion, docs/47) and connectors (canonical order/product import): this
// is a staging → core → analytics data-warehouse pipeline that ingests external marketing signals (social
// feeds, per-channel daily sales, sentiment) and produces a channel ROI / budget-allocation model run.
//
// The original design draft used three separate Postgres schemas (staging/core/analytics) with no tenant
// scoping and a fatal `date`/`channel`/`customer_id` primary-key choice. This codebase is single-schema
// (`public`) with mandatory per-table RLS (docs/ops/tenancy-model.md), so every table below lives in
// `public`, carries `tenant_id` + the canonical org-clause `tenant_isolation` policy (migration 0405), a
// leading `(tenant_id, …)` index (tenant-idx gate), and a surrogate `bigserial` id.
import { pgTable, bigserial, bigint, text, integer, numeric, jsonb, timestamp, date, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── STAGING ──────────────────────────────────────────────────────────────────────────────────────────
// Raw social payloads exactly as pulled from an external platform API, kept for replay/re-derivation. The
// whole JSON blob is retained; the cleaned/aggregated form lives in mmm_sentiment_trends (core).
export const mmmSocialRawFeeds = pgTable('mmm_social_raw_feeds', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  platform: text('platform').notNull(),                       // tiktok | x | instagram | facebook | …
  rawPayload: jsonb('raw_payload').notNull(),                 // the entire JSON blob returned by the API
  extractedAt: timestamp('extracted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxTenantPlatform: index('idx_mmm_social_raw_feeds_tenant').on(t.tenantId, t.platform, t.extractedAt),
}));

// Per-channel daily sales, ingested from ERP/analytics as a denormalised MMM input (NOT a cross-domain
// join into the sales tables — the warehouse pattern is an explicit ingest via POST /api/mmm/sales-daily).
// The draft's `date PRIMARY KEY` collapsed every product/channel/tenant onto one row per day; the real key
// is (tenant, day, sku, utm_source, promo_code).
export const mmmSalesDaily = pgTable('mmm_sales_daily', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  bizDate: date('biz_date').notNull(),                        // business day (Asia/Bangkok, bizYmdDash)
  // Dimension-key columns are NOT NULL DEFAULT '' (no NULLs in a warehouse grain key) so the composite
  // unique index + onConflict upsert are stable across PGlite/Postgres. '' = organic / non-promo / no sku.
  productSku: text('product_sku').notNull().default(''),
  revenue: numeric('revenue', { precision: 14, scale: 2 }).notNull().default('0'),
  unitsSold: integer('units_sold').notNull().default(0),
  utmSource: text('utm_source').notNull().default(''),        // the attributed marketing channel
  promoCode: text('promo_code').notNull().default(''),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxTenant: index('idx_mmm_sales_daily_tenant').on(t.tenantId, t.bizDate),
  uqRow: uniqueIndex('uq_mmm_sales_daily').on(t.tenantId, t.bizDate, t.productSku, t.utmSource, t.promoCode),
}));

// ── CORE ─────────────────────────────────────────────────────────────────────────────────────────────
// Cleaned, per-day social sentiment (the analysable form of mmm_social_raw_feeds). sentiment_score is a
// unit interval [-1, 1] (DB CHECK in the migration).
export const mmmSentimentTrends = pgTable('mmm_sentiment_trends', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  bizDate: date('biz_date').notNull(),
  platform: text('platform').notNull(),
  keywordOrTopic: text('keyword_or_topic').notNull().default(''),   // '' = overall / untagged (grain key)
  mentionCount: integer('mention_count').notNull().default(0),
  sentimentScore: numeric('sentiment_score', { precision: 3, scale: 2 }),   // -1.00 … 1.00
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxTenant: index('idx_mmm_sentiment_trends_tenant').on(t.tenantId, t.bizDate),
  uqRow: uniqueIndex('uq_mmm_sentiment_trends').on(t.tenantId, t.bizDate, t.platform, t.keywordOrTopic),
}));

// Derived per-customer behavioural aggregate. Keyed by the customer master's BUSINESS key (customer_no) —
// never the master's surrogate id and never a cross-tenant-colliding string PK. This is a materialised
// analytics roll-up, not a second source of truth for the customer master (bounded-context rule 3).
export const mmmCustomerBehavior = pgTable('mmm_customer_behavior', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  customerNo: text('customer_no').notNull(),                  // → customer_master.customer_no (business key)
  lastPurchaseDate: date('last_purchase_date'),
  totalOrders: integer('total_orders').notNull().default(0),
  totalSpend: numeric('total_spend', { precision: 14, scale: 2 }).notNull().default('0'),
  avgSocialSentimentInteraction: numeric('avg_social_sentiment_interaction', { precision: 3, scale: 2 }),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxTenant: index('idx_mmm_customer_behavior_tenant').on(t.tenantId),
  uqCustomer: uniqueIndex('uq_mmm_customer_behavior').on(t.tenantId, t.customerNo),
}));

// ── ANALYTICS ────────────────────────────────────────────────────────────────────────────────────────
// A single model run: its window + the spend the analyst attributed per channel + who ran it. The draft's
// single `mmm_results` row-per-channel overwrote history and captured no inputs; a SOX codebase needs the
// run header (inputs, actor, timestamp) so every result set is reproducible and auditable.
export const mmmModelRuns = pgTable('mmm_model_runs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  runNo: text('run_no').notNull(),                            // MMM-YYYYMMDD-NNN
  windowDays: integer('window_days').notNull(),
  totalSpend: numeric('total_spend', { precision: 14, scale: 2 }).notNull().default('0'),
  spendByChannel: jsonb('spend_by_channel').notNull().default({}),  // { channel: spendTHB }
  status: text('status').notNull().default('complete'),       // complete | error
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxTenant: index('idx_mmm_model_runs_tenant').on(t.tenantId, t.createdAt),
  uqRunNo: uniqueIndex('uq_mmm_model_runs').on(t.tenantId, t.runNo),
}));

// The per-channel model output — the deliverable the dashboard (and, in the draft, "Streamlit") reads.
export const mmmChannelResults = pgTable('mmm_channel_results', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  runId: bigint('run_id', { mode: 'number' }).notNull().references(() => mmmModelRuns.id),
  channel: text('channel').notNull(),
  spend: numeric('spend', { precision: 14, scale: 2 }).notNull().default('0'),
  attributedRevenue: numeric('attributed_revenue', { precision: 14, scale: 2 }).notNull().default('0'),
  roi: numeric('roi', { precision: 8, scale: 2 }),
  salesLiftContribution: numeric('sales_lift_contribution', { precision: 5, scale: 2 }),   // % share 0-100
  optimalBudgetAllocation: numeric('optimal_budget_allocation', { precision: 14, scale: 2 }),
}, (t) => ({
  idxTenant: index('idx_mmm_channel_results_tenant').on(t.tenantId, t.runId),
  uqRow: uniqueIndex('uq_mmm_channel_results').on(t.tenantId, t.runId, t.channel),
}));

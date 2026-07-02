import { pgTable, bigserial, bigint, smallint, text, numeric, integer, date, timestamp, boolean, jsonb, primaryKey } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const marketingCampaigns = pgTable('marketing_campaigns', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  campaignId: text('campaign_id').unique(),
  campaignName: text('campaign_name'),
  campaignType: text('campaign_type').default('Popup'),
  contentText: text('content_text'),
  imageKey: text('image_key'),
  tickerText: text('ticker_text'),
  startDate: date('start_date'),
  endDate: date('end_date'),
  targetType: text('target_type').default('All'),
  targetValue: text('target_value'),
  priority: integer('priority'),
  active: boolean('active').default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

export const campaignReads = pgTable('campaign_reads', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  campaignId: text('campaign_id'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  readAt: timestamp('read_at', { withTimezone: true }),
  action: text('action').default('Closed'),
});

export const abTests = pgTable('ab_tests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  testId: text('test_id').unique(),
  testName: text('test_name'),
  campaignId: text('campaign_id'),
  status: text('status').default('Running'),
  startDate: date('start_date'),
  endDate: date('end_date'),
  winner: text('winner'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

export const abVariants = pgTable('ab_variants', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  testId: text('test_id'),
  variant: text('variant'),
  contentText: text('content_text'),
  imageKey: text('image_key'),
  impressions: integer('impressions').default(0),
  clicks: integer('clicks').default(0),
  conversions: integer('conversions').default(0),
});

export const promotions = pgTable('promotions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  // Owning shop. A promo code is private to its tenant (RLS) → one shop's traffic can't exhaust or
  // even discover another's code. Null = legacy/global (pre-tenant rows). Set at createPromotion.
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  promoId: text('promo_id').unique(),
  promoName: text('promo_name'),
  promoType: text('promo_type'),
  startDate: date('start_date'),
  endDate: date('end_date'),
  minQty: numeric('min_qty'),
  minAmount: numeric('min_amount', { precision: 14, scale: 2 }),
  discountPct: numeric('discount_pct'),
  discountAmt: numeric('discount_amt', { precision: 14, scale: 2 }),
  freeItemId: text('free_item_id'),
  freeQty: numeric('free_qty'),
  customerGroup: text('customer_group').default('All'),
  category: text('category'),
  maxUses: integer('max_uses'),
  usedCount: integer('used_count').default(0),
  active: boolean('active').default(true),
  notes: text('notes'),
});

// POS discount/promo audit — one row per promo applied at checkout. tenant_id REQUIRED (RLS).
export const promoRedemptions = pgTable('promo_redemptions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  promoId: bigint('promo_id', { mode: 'number' }).references(() => promotions.id),
  promoCode: text('promo_code'),
  saleNo: text('sale_no'),
  orderNo: text('order_no'),
  discountAmount: numeric('discount_amount', { precision: 14, scale: 2 }),
  appliedBy: text('applied_by'),
  appliedAt: timestamp('applied_at', { withTimezone: true }).defaultNow(),
});

// เดิม Item_IDs CSV → junction
export const promotionItems = pgTable(
  'promotion_items',
  {
    promoId: bigint('promo_id', { mode: 'number' }).notNull().references(() => promotions.id),
    itemId: text('item_id').notNull(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // RLS-scope with its promo
  },
  (t) => ({ pk: primaryKey({ columns: [t.promoId, t.itemId] }) }),
);

export const priceList = pgTable('price_list', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  listName: text('list_name').default('Standard'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // null = All Customers
  itemId: text('item_id'),
  itemDescription: text('item_description'),
  basePrice: numeric('base_price', { precision: 14, scale: 2 }),
  specialPrice: numeric('special_price', { precision: 14, scale: 2 }),
  discountPct: numeric('discount_pct'),
  minQty: numeric('min_qty').default('1'),
  validFrom: date('valid_from'),
  validTo: date('valid_to'),
  active: boolean('active').default(true),
});

// singleton
export const loyaltyConfig = pgTable('loyalty_config', {
  id: smallint('id').primaryKey().default(1),
  enabled: boolean('enabled').default(false),
  pointsPerBaht: numeric('points_per_baht').default('1.0'),
  bahtPerPoint: numeric('baht_per_point').default('0.1'),
  minRedeem: numeric('min_redeem').default('100'),
  expiryDays: integer('expiry_days').default(365),
  transferDayCap: integer('transfer_day_cap').notNull().default(1000), // W1 LYL-18: max points a member may transfer out per day (0 = transfers disabled)
  updatedAt: timestamp('updated_at', { withTimezone: true }),
});

export const loyaltyPoints = pgTable('loyalty_points', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id).unique(),
  balance: numeric('balance').default('0'),
  lifetime: numeric('lifetime').default('0'),
  lastUpdated: timestamp('last_updated', { withTimezone: true }),
});

export const loyaltyTxn = pgTable('loyalty_txn', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  txnDate: timestamp('txn_date', { withTimezone: true }),
  txnType: text('txn_type'),
  points: numeric('points'),
  balanceAfter: numeric('balance_after'),
  refDoc: text('ref_doc'),
  notes: text('notes'),
});

export const abandonedCarts = pgTable('abandoned_carts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  cartData: jsonb('cart_data'),
  createdAt: timestamp('created_at', { withTimezone: true }),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  recovered: boolean('recovered').default(false),
});

export const surveys = pgTable('surveys', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  surveyId: text('survey_id').unique(),
  surveyName: text('survey_name'),
  surveyType: text('survey_type').default('NPS'),
  trigger: text('trigger').default('Post-Delivery'),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }),
});

export const surveyResponses = pgTable('survey_responses', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  surveyId: text('survey_id'),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  orderNo: text('order_no'),
  responseDate: date('response_date'),
  npsScore: integer('nps_score'),
  comments: text('comments'),
});

// เดิม Q1-Q3 fixed → EAV
export const surveyAnswers = pgTable('survey_answers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  responseId: bigint('response_id', { mode: 'number' }).references(() => surveyResponses.id),
  questionNo: integer('question_no'),
  answer: text('answer'),
});

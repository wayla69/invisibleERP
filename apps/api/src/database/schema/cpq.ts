import { pgTable, bigserial, bigint, text, numeric, integer, boolean, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { opportunities } from './pipeline';
import { crmOpportunities } from './crm-pipeline';

// ── Batch 2B: CPQ (Configure-Price-Quote) ─────────────────────────────────────

export const productConfigs = pgTable('product_configs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  basePrice: numeric('base_price', { precision: 18, scale: 4 }).notNull().default('0'),
  currency: text('currency').notNull().default('THB'),
  description: text('description'),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqCode: uniqueIndex('uq_pc_code').on(t.tenantId, t.code),
}));

export const configOptions = pgTable('config_options', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  configId: bigint('config_id', { mode: 'number' }).notNull().references(() => productConfigs.id),
  groupName: text('group_name').notNull(),
  optionCode: text('option_code').notNull(),
  optionName: text('option_name').notNull(),
  priceDelta: numeric('price_delta', { precision: 18, scale: 4 }).notNull().default('0'),
  isDefault: boolean('is_default').default(false),
  isActive: boolean('is_active').default(true),
}, (t) => ({
  byConfig: index('idx_co_config').on(t.configId, t.groupName),
  uqOption: uniqueIndex('uq_co_option').on(t.configId, t.groupName, t.optionCode),
}));

// rule_type: 'volume' | 'discount_pct' | 'bundle'
export const pricingRules = pgTable('pricing_rules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  configId: bigint('config_id', { mode: 'number' }).references(() => productConfigs.id),
  name: text('name').notNull(),
  ruleType: text('rule_type').notNull().default('volume'),
  discountPct: numeric('discount_pct', { precision: 7, scale: 4 }).notNull().default('0'),
  minQty: integer('min_qty').notNull().default(1),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byConfig: index('idx_pr_config').on(t.configId),
}));

// status: 'Draft' | 'Sent' | 'Accepted' | 'Rejected' | 'Expired'
export const quotes = pgTable('quotes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  quoteNo: text('quote_no').notNull().unique(),
  // CRM-1 unification (0294): crm_opportunity_id is the LIVE opportunity link (→ crm_opportunities);
  // opportunity_id is read-legacy (→ the retired Batch 2A `opportunities` table) — existing rows were
  // repointed (crm_opportunity_id backfilled via legacy_opportunity_id) and no new row writes it.
  opportunityId: bigint('opportunity_id', { mode: 'number' }).references(() => opportunities.id),
  crmOpportunityId: bigint('crm_opportunity_id', { mode: 'number' }).references(() => crmOpportunities.id),
  configId: bigint('config_id', { mode: 'number' }).references(() => productConfigs.id),
  customerName: text('customer_name').notNull(),
  status: text('status').notNull().default('Draft'),
  validityDays: integer('validity_days').notNull().default(30),
  issuedDate: date('issued_date'),
  expiresDate: date('expires_date'),
  currency: text('currency').notNull().default('THB'),
  subtotal: numeric('subtotal', { precision: 18, scale: 4 }).notNull().default('0'),
  discountTotal: numeric('discount_total', { precision: 18, scale: 4 }).notNull().default('0'),
  total: numeric('total', { precision: 18, scale: 4 }).notNull().default('0'),
  notes: text('notes'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_qt_tenant').on(t.tenantId, t.status),
}));

export const quoteLines = pgTable('quote_lines', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  quoteId: bigint('quote_id', { mode: 'number' }).notNull().references(() => quotes.id),
  lineNo: integer('line_no').notNull(),
  itemCode: text('item_code'),
  description: text('description').notNull(),
  qty: numeric('qty', { precision: 10, scale: 2 }).notNull().default('1'),
  unitPrice: numeric('unit_price', { precision: 18, scale: 4 }).notNull().default('0'),
  discountPct: numeric('discount_pct', { precision: 7, scale: 4 }).notNull().default('0'),
  lineTotal: numeric('line_total', { precision: 18, scale: 4 }).notNull().default('0'),
}, (t) => ({
  byQuote: index('idx_ql_quote').on(t.quoteId),
}));

export type Quote = typeof quotes.$inferSelect;

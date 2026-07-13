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

// status: 'Draft' | 'Sent' | 'PendingApproval' | 'Accepted' | 'Rejected' | 'Expired'
//   SVC-1 (CPQ-01): a quote whose effective discount% breaches max_discount_pct OR whose margin% is below
//   min_margin_pct (per-tenant floor, cpq_settings) parks in 'PendingApproval' on send — it cannot be
//   sent/accepted until a DIFFERENT authorised user approves (author cannot self-approve → SOD_SELF_APPROVAL).
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
  // SVC-1 (CPQ-01): the quote's effective discount% (gross→net) and margin% (net vs unit cost), computed on
  // send. requires_approval flips true when a floor is breached; approved_by/approved_at record the checker.
  discountPct: numeric('discount_pct', { precision: 6, scale: 3 }).notNull().default('0'),
  marginPct: numeric('margin_pct', { precision: 6, scale: 3 }),
  requiresApproval: boolean('requires_approval').notNull().default(false),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
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
  // SVC-1 (CPQ-01): unit cost (COGS basis) captured per line so the margin floor is enforceable.
  unitCost: numeric('unit_cost', { precision: 14, scale: 2 }).notNull().default('0'),
  discountPct: numeric('discount_pct', { precision: 7, scale: 4 }).notNull().default('0'),
  lineTotal: numeric('line_total', { precision: 18, scale: 4 }).notNull().default('0'),
  // CRM-14 (CRM-12, migration 0399): tags lines expanded from a bundle instance (bundle code + instance
  // suffix) so they're grouped on the quote; null for an ordinary line.
  bundleCode: text('bundle_code'),
}, (t) => ({
  byQuote: index('idx_ql_quote').on(t.quoteId),
}));

// SVC-1 (CPQ-01): per-tenant discount/margin floor. One row per tenant (defaults 20% margin / 15% discount).
export const cpqSettings = pgTable('cpq_settings', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  minMarginPct: numeric('min_margin_pct', { precision: 6, scale: 3 }).notNull().default('20'),
  maxDiscountPct: numeric('max_discount_pct', { precision: 6, scale: 3 }).notNull().default('15'),
  // CRM-14 (CRM-12, migration 0399): the tier-2 discount threshold — a breach above max_discount_pct but
  // at/under this still needs any cpq_approve holder (manager tier, unchanged); above it needs `exec`
  // specifically. Null = tiering off (today's single-floor behaviour).
  execDiscountPct: numeric('exec_discount_pct', { precision: 6, scale: 3 }),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: uniqueIndex('idx_cpq_settings_tenant').on(t.tenantId),
}));

// SVC-1 (CPQ-01): the maker-checker audit row for a floor-breaching quote. status: 'pending'|'approved'|'rejected'.
export const quoteApprovals = pgTable('quote_approvals', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  quoteId: bigint('quote_id', { mode: 'number' }).notNull().references(() => quotes.id),
  requestedBy: text('requested_by'),
  approvedBy: text('approved_by'),
  status: text('status').notNull().default('pending'),
  reason: text('reason'),
  // Floor snapshot at request time + the actuals that breached it (evidence for the ToE).
  minMarginPct: numeric('min_margin_pct', { precision: 6, scale: 3 }),
  maxDiscountPct: numeric('max_discount_pct', { precision: 6, scale: 3 }),
  marginPct: numeric('margin_pct', { precision: 6, scale: 3 }),
  discountPct: numeric('discount_pct', { precision: 6, scale: 3 }),
  // CRM-14 (CRM-12, migration 0399): which approval tier this breach requires — 'manager' (any cpq_approve
  // holder, unchanged) or 'exec' (the exec-tier threshold was crossed).
  requiredTier: text('required_tier'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
}, (t) => ({
  byQuote: index('idx_quote_appr_quote').on(t.tenantId, t.quoteId),
  byStatus: index('idx_quote_appr_status').on(t.tenantId, t.status),
}));

// CRM-14 (CRM-12, migration 0399): a bundle SKU priced as the discounted sum of its component product
// configs. Expands into ordinary quote_lines on add (bundleCode-tagged), so the EXISTING CPQ-01 floor check
// automatically covers a bundle's blended margin — no core service duplication.
export const cpqBundles = pgTable('cpq_bundles', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqCode: uniqueIndex('uq_cpq_bundle_code').on(t.tenantId, t.code) }));

export const cpqBundleItems = pgTable('cpq_bundle_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  bundleId: bigint('bundle_id', { mode: 'number' }).notNull().references(() => cpqBundles.id),
  configId: bigint('config_id', { mode: 'number' }).notNull().references(() => productConfigs.id),
  qty: numeric('qty', { precision: 10, scale: 2 }).notNull().default('1'),
  unitCost: numeric('unit_cost', { precision: 14, scale: 2 }).notNull().default('0'), // component COGS
  sequence: integer('sequence').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byBundle: index('idx_cpq_bundle_item_bundle').on(t.tenantId, t.bundleId) }));

export type Quote = typeof quotes.$inferSelect;

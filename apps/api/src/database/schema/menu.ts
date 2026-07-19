// POS Menu / Catalog master: categories, menu items (price, SKU/barcode, KDS station, 86 availability),
// priced modifier groups + options (size, add-ons), and the item↔group link. The single source of truth
// POS / dine-in / portal order entry resolves a priced line against. Every table carries tenant_id (RLS).
import { pgTable, bigserial, bigint, text, numeric, integer, boolean, timestamp, pgEnum, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const menuItemTypeEnum = pgEnum('menu_item_type', ['food', 'drink', 'retail', 'combo']);
export const menuTaxTypeEnum = pgEnum('menu_tax_type', ['standard', 'exempt', 'zero']);

export const menuCategories = pgTable('menu_categories', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  nameEn: text('name_en'),
  color: text('color'),
  sort: integer('sort').default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqCat: unique('uq_menu_cat').on(t.tenantId, t.code) }));

export const menuItems = pgTable('menu_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  sku: text('sku').notNull(),                                   // barcode / PLU
  name: text('name').notNull(),
  nameEn: text('name_en'),
  categoryId: bigint('category_id', { mode: 'number' }).references(() => menuCategories.id),
  type: menuItemTypeEnum('type').notNull().default('food'),
  price: numeric('price', { precision: 14, scale: 2 }).notNull(),
  cost: numeric('cost', { precision: 14, scale: 2 }),
  stationCode: text('station_code').default('main'),           // KDS routing
  prepMinutes: integer('prep_minutes').default(10),
  taxType: menuTaxTypeEnum('tax_type').notNull().default('standard'),
  trackStock: boolean('track_stock').notNull().default(false),
  isAvailable: boolean('is_available').notNull().default(true), // 86 toggle
  // "เมนูแนะนำ" — surfaced first on the diner QR menu (0434).
  isRecommended: boolean('is_recommended').notNull().default(false),
  // KDS food-prioritisation (0434): higher plates out first within one fire lot. Snapshot onto the kitchen line.
  kdsPriority: integer('kds_priority').notNull().default(0),
  // day-parting: time-of-day + day-of-week availability (Asia/Bangkok). null = always available.
  availDays: text('avail_days'),                               // 7-char mask, index 0=Sunday
  availStartMin: integer('avail_start_min'),                   // minutes from midnight (inclusive)
  availEndMin: integer('avail_end_min'),                       // minutes from midnight (exclusive)
  imageUrl: text('image_url'),
  description: text('description'),
  // weighed items (deli/produce): when true, `price` is the price per `weightUnit` and the line amount
  // comes from a scale reading (Phase 5 peripherals).
  soldByWeight: boolean('sold_by_weight').notNull().default(false),
  weightUnit: text('weight_unit').default('kg'),               // kg | g
  sort: integer('sort').default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqSku: unique('uq_menu_sku').on(t.tenantId, t.sku), byCat: index('idx_menu_item_cat').on(t.categoryId) }));

export const modifierGroups = pgTable('modifier_groups', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  minSelect: integer('min_select').notNull().default(0),
  maxSelect: integer('max_select').notNull().default(1),
  required: boolean('required').notNull().default(false),
  sort: integer('sort').default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqGrp: unique('uq_mod_group').on(t.tenantId, t.code) }));

export const modifierOptions = pgTable('modifier_options', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  groupId: bigint('group_id', { mode: 'number' }).notNull().references(() => modifierGroups.id),
  name: text('name').notNull(),
  priceDelta: numeric('price_delta', { precision: 14, scale: 2 }).notNull().default('0'),
  // Step 1 — standard COGS impact of choosing this option (e.g. "extra patty" → 12.00). Folded into the
  // sold line's recipe COGS at checkout (Dr 5300 / Cr 1200). recipeRefId is a forward hook for future
  // ingredient-level deduction off a mini-recipe (not yet costed).
  cogsDelta: numeric('cogs_delta', { precision: 14, scale: 2 }).notNull().default('0'),
  recipeRefId: bigint('recipe_ref_id', { mode: 'number' }),
  isDefault: boolean('is_default').notNull().default(false),
  sort: integer('sort').default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const menuItemModifierGroups = pgTable('menu_item_modifier_groups', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  menuItemId: bigint('menu_item_id', { mode: 'number' }).notNull().references(() => menuItems.id),
  groupId: bigint('group_id', { mode: 'number' }).notNull().references(() => modifierGroups.id),
  sort: integer('sort').default(0),
}, (t) => ({ uqLink: unique('uq_item_group').on(t.menuItemId, t.groupId) }));

// ── Buffet packages / tiers (Phase 2) — per-pax price + dining time window; food billed at ฿0 ──
export const buffetPackages = pgTable('buffet_packages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  nameEn: text('name_en'),
  pricePerPax: numeric('price_per_pax', { precision: 14, scale: 2 }).notNull(),
  timeLimitMin: integer('time_limit_min').notNull().default(90),
  overtimeFeePerPax: numeric('overtime_fee_per_pax', { precision: 14, scale: 2 }).notNull().default('0'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqPkg: unique('buffet_packages_tenant_code_uq').on(t.tenantId, t.code) }));

// which menu items a tier includes (eligibility) — anything not listed can't be ordered on that tier
export const buffetPackageItems = pgTable('buffet_package_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  packageId: bigint('package_id', { mode: 'number' }).notNull().references(() => buffetPackages.id),
  menuItemId: bigint('menu_item_id', { mode: 'number' }).notNull().references(() => menuItems.id),
}, (t) => ({ uqLink: unique('buffet_package_items_uq').on(t.packageId, t.menuItemId) }));

export type MenuItem = typeof menuItems.$inferSelect;
export type MenuCategory = typeof menuCategories.$inferSelect;
export type ModifierGroup = typeof modifierGroups.$inferSelect;
export type BuffetPackage = typeof buffetPackages.$inferSelect;

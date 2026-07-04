import { pgTable, bigserial, bigint, text, numeric, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Item-posting setup master data (docs/33, GL-21). These tables give item posting an explicit,
// tenant-configurable account/tax profile so a transaction's GL/VAT/WHT accounts are DERIVED from the item
// (via item → category → warehouse → global posting-rule default) rather than hardcoded. PR1 adds the tables +
// item columns only; PR2 wires PostingService to resolve against them. Nullable columns fall through the
// precedence chain, so an unconfigured tenant behaves exactly as today.

// Item / product category master — replaces the free-text items.category with a real table that carries a
// default account-set + tax profile for a family of items. Tenant-scoped (RLS, 0232 org-clause form).
export const itemCategories = pgTable('item_categories', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),               // natural key per tenant
  name: text('name'),
  nameTh: text('name_th'),
  // Default GL accounts for items in this category (null → fall through to warehouse/global default).
  revenueAccount: text('revenue_account'),
  cogsAccount: text('cogs_account'),
  inventoryAccount: text('inventory_account'),
  valuationAccount: text('valuation_account'),
  // Tax profile: references tax_codes.code (vat) / an income type for WHT-bearing service/labour categories.
  vatCode: text('vat_code'),
  whtIncomeType: text('wht_income_type'),      // e.g. '40(7-8)' ค่าจ้างทำของ, '3tre-service' ค่าบริการ
  defaultLocationId: text('default_location_id'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqCatCode: uniqueIndex('uq_item_categories_code').on(t.tenantId, t.code),
}));

// Tax-code master (VAT + WHT). Replaces the lone tenants.vatRate column as the configurable tax surface.
// A vat code carries output/input VAT accounts + rate; a wht code carries the WHT payable account + the
// Thai income type. Tenant-scoped (RLS). Day-one seed mirrors the current 7%→2100 behavior (see 0243).
export const taxCodes = pgTable('tax_codes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),               // VAT7 | VAT0 | EXEMPT | WHT3 | ...
  name: text('name'),
  nameTh: text('name_th'),
  kind: text('kind').notNull().default('vat'), // 'vat' | 'wht'
  rate: numeric('rate', { precision: 6, scale: 4 }).notNull().default('0'), // 0.0700 = 7%
  outputAccount: text('output_account'),       // VAT payable on sales (today: 2100)
  inputAccount: text('input_account'),         // VAT credit on purchases (today: 2100)
  whtAccount: text('wht_account'),             // WHT payable (2361 vendor / 2360 payroll)
  whtIncomeType: text('wht_income_type'),      // for kind='wht'
  inclusive: boolean('inclusive').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqTaxCode: uniqueIndex('uq_tax_codes_code').on(t.tenantId, t.code),
}));

export type ItemCategory = typeof itemCategories.$inferSelect;
export type TaxCode = typeof taxCodes.$inferSelect;

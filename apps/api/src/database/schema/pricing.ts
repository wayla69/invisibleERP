import { pgTable, bigserial, bigint, text, numeric, integer, boolean, date, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Promotion / pricing rules evaluated by PricingService.quote (happy-hour, %/amount/fixed, BOGO, qty-break).
export const priceRules = pgTable('price_rules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  name: text('name').notNull(),
  scope: text('scope').default('all'),       // all | item | category
  targetId: text('target_id'),
  channel: text('channel').default('any'),   // any | dine_in | takeaway | delivery
  location: text('location'),
  dow: text('dow'),                           // comma list of ISO weekdays 1..7
  timeStart: text('time_start'),             // 'HH:MM'
  timeEnd: text('time_end'),
  type: text('type').notNull(),              // percent | amount | fixed | bogo | qty_break
  value: numeric('value', { precision: 14, scale: 4 }).default('0'),
  minQty: integer('min_qty').default(1),
  priority: integer('priority').default(100),
  stackable: boolean('stackable').default(false),
  active: boolean('active').default(true),
  validFrom: date('valid_from'),
  validTo: date('valid_to'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  // Price/promo maker-checker (audit G6, migration 0262): a new/changed rule is staged 'PendingApproval'
  // and kept inactive until a DIFFERENT user activates it. Legacy rows default 'Active'.
  status: text('status').notNull().default('Active'), // Active | PendingApproval | Rejected
  approvedBy: text('approved_by'),                     // checker — must differ from createdBy
  approvedAt: timestamp('approved_at', { withTimezone: true }),
});

// docs/52 Phase 4a — price books: a governed, approved base-price list the POS draws from, resolved by
// CUSTOMER TIER and/or BRANCH before the promo engine (price_rules) applies its discounts. This closes the
// "prices typed freely at the line, no approved basis" gap (cf. CRM-15) at the till: a book holds a per-item
// unit price, is maker-checker (staged PendingApproval, activated by a DIFFERENT user — mirrors the price-rule
// G6 gate), and the sale path reads only active/approved books. Tenant-scoped (RLS 0447).
export const priceBooks = pgTable('price_books', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  name: text('name').notNull(),
  tier: text('tier'),                          // customer price tier this book serves (e.g. retail|wholesale|vip|member); NULL = any tier
  branchId: bigint('branch_id', { mode: 'number' }), // outlet this book serves; NULL = any branch
  customerCode: text('customer_code'),         // B2B contract pricing: the specific customer this book serves; NULL = any customer. Most specific — wins over tier/branch books.
  currency: text('currency').notNull().default('THB'),
  priority: integer('priority').notNull().default(100), // lower = higher precedence when several books match
  active: boolean('active').notNull().default(false),
  // Maker-checker (mirrors price_rules G6): a new/changed book is staged PendingApproval + inactive; the sale
  // path reads only active=true AND status='Active'. A DIFFERENT user activates it (self-approval → SOD_VIOLATION).
  status: text('status').notNull().default('PendingApproval'), // Active | PendingApproval | Rejected
  validFrom: date('valid_from'),
  validTo: date('valid_to'),
  createdBy: text('created_by'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_price_books_tenant').on(t.tenantId, t.status, t.priority),
}));

// A per-item price within a book (optional min_qty for a book-local qty break; the highest min_qty ≤ the sold
// qty wins). Prices are the book's currency; the till override applies only when a matching, approved book
// holds an entry for the item.
export const priceBookEntries = pgTable('price_book_entries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  priceBookId: bigint('price_book_id', { mode: 'number' }).notNull().references(() => priceBooks.id),
  itemId: text('item_id').notNull(),
  unitPrice: numeric('unit_price', { precision: 14, scale: 4 }).notNull(),
  minQty: integer('min_qty').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byBook: index('idx_price_book_entries_tenant').on(t.tenantId, t.priceBookId, t.itemId),
  uqEntry: unique('uq_price_book_entry').on(t.tenantId, t.priceBookId, t.itemId, t.minQty),
}));

// Combo (set-menu) component lines — exploded into priced lines by the quote engine.
export const comboComponents = pgTable('combo_components', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  comboSku: text('combo_sku').notNull(),
  componentSku: text('component_sku').notNull(),
  qty: numeric('qty', { precision: 14, scale: 2 }).default('1'),
  unitPriceOverride: numeric('unit_price_override', { precision: 14, scale: 2 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

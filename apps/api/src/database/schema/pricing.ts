import { pgTable, bigserial, bigint, text, numeric, integer, boolean, date, timestamp } from 'drizzle-orm/pg-core';
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

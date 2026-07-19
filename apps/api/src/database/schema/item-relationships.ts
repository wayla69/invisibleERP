// Item relationships (master-data audit Phase 10) — product-master relational depth: substitute / complement
// (cross-sell) / supersedes / kit_component / accessory. Directional (from → to). TENANT-SCOPED even though
// `items` is a shared master, because substitutes/cross-sell are per-shop merchandising choices, not global
// facts (RLS + leading index + change-audit trigger like the party relationships in Phase 8). Migration 0276.
// `qty` (docs/52 Phase 2c, migration 0441) is the per-component count for a kit_component row — how many of
// `to_item_id` a sale of the kit parent `from_item_id` consumes; default 1 (inert for the advisory rel types).
import { pgTable, bigserial, bigint, text, numeric, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { items } from './inventory';

export const itemRelationships = pgTable('item_relationships', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  fromItemId: bigint('from_item_id', { mode: 'number' }).notNull().references(() => items.id),
  toItemId: bigint('to_item_id', { mode: 'number' }).notNull().references(() => items.id),
  relType: text('rel_type').notNull().default('substitute'),
  qty: numeric('qty', { precision: 14, scale: 3 }).notNull().default('1'),  // kit_component: components consumed per kit sold (0441)
  note: text('note'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_item_relationships_tenant').on(t.tenantId),
  byFrom: index('idx_item_relationships_from').on(t.fromItemId),
  uq: uniqueIndex('uq_item_relationships').on(t.tenantId, t.fromItemId, t.toItemId, t.relType),
}));

export type ItemRelationship = typeof itemRelationships.$inferSelect;

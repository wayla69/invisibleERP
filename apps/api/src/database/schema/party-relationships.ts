// Typed party relationships (master-data audit Phase 8 — Oracle-TCA-style). Directional (from → to) relations
// between two customers or two vendors, typed (bill_to / ship_to / sold_to / guarantor / related_party /
// subsidiary / franchisee / …). Generalises Phase 4's single parent pointer. Migration 0275.
import { pgTable, bigserial, bigint, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { customerMaster } from './customer-master';
import { vendors } from './procurement';

export const customerRelationships = pgTable('customer_relationships', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  fromCustomerId: bigint('from_customer_id', { mode: 'number' }).notNull().references(() => customerMaster.id),
  toCustomerId: bigint('to_customer_id', { mode: 'number' }).notNull().references(() => customerMaster.id),
  relType: text('rel_type').notNull().default('related_party'),
  note: text('note'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_customer_relationships_tenant').on(t.tenantId),
  byFrom: index('idx_customer_relationships_from').on(t.fromCustomerId),
  uq: uniqueIndex('uq_customer_relationships').on(t.fromCustomerId, t.toCustomerId, t.relType),
}));

export const vendorRelationships = pgTable('vendor_relationships', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  fromVendorId: bigint('from_vendor_id', { mode: 'number' }).notNull().references(() => vendors.id),
  toVendorId: bigint('to_vendor_id', { mode: 'number' }).notNull().references(() => vendors.id),
  relType: text('rel_type').notNull().default('related_party'),
  note: text('note'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_vendor_relationships_tenant').on(t.tenantId),
  byFrom: index('idx_vendor_relationships_from').on(t.fromVendorId),
  uq: uniqueIndex('uq_vendor_relationships').on(t.fromVendorId, t.toVendorId, t.relType),
}));

export type CustomerRelationship = typeof customerRelationships.$inferSelect;
export type VendorRelationship = typeof vendorRelationships.$inferSelect;

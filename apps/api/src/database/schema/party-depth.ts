// Party-model depth (master-data audit Phase 4) — multi-address and multi-contact child tables for the
// customer and vendor masters. Before this, both masters carried exactly ONE address and ONE contact
// (a single scalar column each), so a customer/vendor with a separate billing/shipping address or more
// than one point of contact had no home for the extra rows. Kept as entity-specific tables (not a shared
// polymorphic "party" table) to match this codebase's existing convention of one table per real-world
// entity (vendor_bank_change_requests, customer_master, …) rather than a generic party abstraction.
import { pgTable, bigserial, bigint, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { customerMaster } from './customer-master';
import { vendors } from './procurement';
import { encryptedText } from '../encrypted-column';

export const customerAddresses = pgTable('customer_addresses', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  customerId: bigint('customer_id', { mode: 'number' }).notNull().references(() => customerMaster.id),
  addressType: text('address_type').notNull().default('other'), // billing | shipping | registered | other
  addressLine1: encryptedText('address_line1'), // street-level detail — PII, not searched → encrypted
  addressLine2: text('address_line2'),
  subDistrict: text('sub_district'),
  district: text('district'),
  province: text('province'),
  postalCode: text('postal_code'),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byCustomer: index('idx_customer_addresses_customer').on(t.customerId),
  byTenant: index('idx_customer_addresses_tenant').on(t.tenantId),
}));

export const customerContacts = pgTable('customer_contacts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  customerId: bigint('customer_id', { mode: 'number' }).notNull().references(() => customerMaster.id),
  name: text('name').notNull(),
  title: text('title'),
  phone: text('phone'),
  email: text('email'),
  notes: text('notes'),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byCustomer: index('idx_customer_contacts_customer').on(t.customerId),
  byTenant: index('idx_customer_contacts_tenant').on(t.tenantId),
}));

export const vendorAddresses = pgTable('vendor_addresses', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  vendorId: bigint('vendor_id', { mode: 'number' }).notNull().references(() => vendors.id),
  addressType: text('address_type').notNull().default('other'), // billing | shipping | registered | other
  addressLine1: encryptedText('address_line1'),
  addressLine2: text('address_line2'),
  subDistrict: text('sub_district'),
  district: text('district'),
  province: text('province'),
  postalCode: text('postal_code'),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byVendor: index('idx_vendor_addresses_vendor').on(t.vendorId),
  byTenant: index('idx_vendor_addresses_tenant').on(t.tenantId),
}));

export const vendorContacts = pgTable('vendor_contacts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  vendorId: bigint('vendor_id', { mode: 'number' }).notNull().references(() => vendors.id),
  name: text('name').notNull(),
  title: text('title'),
  phone: text('phone'),
  email: text('email'),
  notes: text('notes'),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byVendor: index('idx_vendor_contacts_vendor').on(t.vendorId),
  byTenant: index('idx_vendor_contacts_tenant').on(t.tenantId),
}));

export type CustomerAddress = typeof customerAddresses.$inferSelect;
export type CustomerContact = typeof customerContacts.$inferSelect;
export type VendorAddress = typeof vendorAddresses.$inferSelect;
export type VendorContact = typeof vendorContacts.$inferSelect;

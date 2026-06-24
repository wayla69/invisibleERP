// Custom objects (Platform Phase 11 — A1). Tenant-defined record types ("custom apps") with no code:
// a registry of objects + a registry of their records. The records' TYPED FIELD VALUES reuse the Phase 1
// custom-fields store (`custom_field_values` keyed by entity = object_key), so a custom object's fields are
// literally custom fields on its own entity. Pure metadata — RLS-scoped, audited, never posts to the GL.
import { pgTable, bigserial, bigint, text, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const customObjects = pgTable('custom_objects', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  objectKey: text('object_key').notNull(),             // slug, unique per tenant; used as the custom-fields `entity`
  label: text('label').notNull(),
  labelEn: text('label_en'),
  icon: text('icon'),                                  // optional lucide icon name (display only)
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const customObjectRecords = pgTable('custom_object_records', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  objectKey: text('object_key').notNull(),
  recordId: text('record_id').notNull(),               // our own id (String(id)); the key into custom_field_values
  displayName: text('display_name'),                   // first field's value, for list views
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export type CustomObject = typeof customObjects.$inferSelect;
export type CustomObjectRecord = typeof customObjectRecords.$inferSelect;

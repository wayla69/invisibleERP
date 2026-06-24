// Object layouts (Platform Phase 12 — A2). A no-code form/layout for a custom object (Phase 11): sections,
// field order, columns, and hidden fields — optionally per role. Pure presentation config resolved against
// the object's current field defs at render time (new fields always surface). RLS-scoped, audited, no GL.
import { pgTable, bigserial, bigint, text, jsonb, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const objectLayouts = pgTable('object_layouts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  objectKey: text('object_key').notNull(),             // the custom object's key (Phase 11)
  role: text('role'),                                  // null = applies to all roles (the object default)
  name: text('name').notNull(),
  config: jsonb('config').notNull().default({}),       // { sections: [{title, columns, fields:[field_key]}], hidden:[field_key] }
  isDefault: boolean('is_default').notNull().default(false), // the active layout for this (object_key, role)
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export type ObjectLayout = typeof objectLayouts.$inferSelect;

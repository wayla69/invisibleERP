// Custom fields (UDFs) — a per-tenant registry of user-defined fields keyed by entity, plus a typed value
// store keyed by (entity, field_key, record_id). Lets a tenant extend any master/transaction without code.
import { pgTable, bigserial, bigint, text, numeric, boolean, integer, date, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const customFieldDefs = pgTable('custom_field_defs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  entity: text('entity').notNull(),                    // customer | item | sales_order | journal | ...
  fieldKey: text('field_key').notNull(),               // slug, unique per tenant+entity
  label: text('label').notNull(),
  labelEn: text('label_en'),
  dataType: text('data_type').notNull().default('text'), // text | number | date | boolean | select
  options: jsonb('options'),                           // choices for data_type=select
  required: boolean('required').notNull().default(false),
  defaultValue: text('default_value'),
  helpText: text('help_text'),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const customFieldValues = pgTable('custom_field_values', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  entity: text('entity').notNull(),
  fieldKey: text('field_key').notNull(),
  recordId: text('record_id').notNull(),               // business/PK id of the target record
  valueText: text('value_text'),
  valueNum: numeric('value_num', { precision: 18, scale: 4 }),
  valueDate: date('value_date'),
  valueBool: boolean('value_bool'),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export type CustomFieldDef = typeof customFieldDefs.$inferSelect;
export type CustomFieldValue = typeof customFieldValues.$inferSelect;

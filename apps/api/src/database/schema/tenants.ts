import { pgTable, bigserial, text, numeric, boolean, timestamp } from 'drizzle-orm/pg-core';

// จาก tbl_customers — เดิม PK = Customer_Name (string). V2: surrogate id + code = ชื่อเดิม
export const tenants = pgTable('tenants', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  code: text('code').notNull().unique(), // legacy Customer_Name / Owner_Customer
  name: text('name').notNull(),
  contactName: text('contact_name'),
  phone: text('phone'),
  email: text('email'),
  taxId: text('tax_id'),
  address: text('address'),
  creditTerm: text('credit_term'),
  creditLimit: numeric('credit_limit', { precision: 14, scale: 2 }).default('0'),
  creditHold: boolean('credit_hold').default(false),
  outstandingAr: numeric('outstanding_ar', { precision: 14, scale: 2 }).default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type Tenant = typeof tenants.$inferSelect;

import { pgTable, bigserial, bigint, text, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const departments = pgTable('departments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqDept: uniqueIndex('uq_dept').on(t.tenantId, t.code),
}));

export type Department = typeof departments.$inferSelect;

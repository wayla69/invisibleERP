import { pgTable, bigserial, bigint, text, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { roleEnum } from './enums';

// Role-based dashboard layouts — one ordered widget list per (tenant, role), set by an admin.
// `widgets` is an ordered array of catalog widget keys; resolution + permission filtering happen at view time.
export const dashboardLayouts = pgTable('dashboard_layouts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  role: roleEnum('role').notNull(),
  widgets: jsonb('widgets').notNull().default([]),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  tenantRole: uniqueIndex('idx_dashboard_layouts_tenant_role').on(t.tenantId, t.role),
}));

import { pgTable, bigserial, bigint, text, timestamp, pgEnum, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Accounting dimension: department / branch / project. Pure dimensional tag on journal_lines —
// NO new GL postings. RLS-scoped. Hierarchy via parentCode (self-ref on code, per-tenant).
export const costCenterTypeEnum = pgEnum('cost_center_type', ['department', 'branch', 'project']);

export const costCenters = pgTable('cost_centers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  type: costCenterTypeEnum('type').notNull().default('department'),
  parentCode: text('parent_code'),
  active: text('active').default('true'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqCcPerTenant: unique('uq_cost_center').on(t.tenantId, t.code), byParent: index('idx_cc_parent').on(t.parentCode) }));

export type CostCenter = typeof costCenters.$inferSelect;

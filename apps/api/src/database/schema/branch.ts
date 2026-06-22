// Multi-branch — physical outlets within a tenant. A tenant (shop business) operates several branches
// that sell independently (offline-first via pos_offline_sync) and roll their sales up to the tenant's
// HQ for consolidation. Tenant-scoped: RLS keeps one shop's branches private to that shop.
import { pgTable, bigserial, bigint, text, boolean, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const branches = pgTable(
  'branches',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id), // owning shop (RLS)
    code: text('code').notNull(),          // branch code, unique per tenant (e.g. BKK01)
    name: text('name').notNull(),
    isHq: boolean('is_hq').default(false), // the tenant's head office
    address: text('address'),
    phone: text('phone'),
    active: boolean('active').default(true),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uqCode: unique('branches_tenant_code_uq').on(t.tenantId, t.code),
    byTenant: index('idx_branches_tenant').on(t.tenantId),
  }),
);

export type Branch = typeof branches.$inferSelect;

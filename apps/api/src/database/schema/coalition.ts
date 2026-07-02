// W2 (docs/27) — coalition network: one points economy across shops, settled in the GL (LYL-19).
// `coalitions` is HQ-owned master data (no tenant_id — like `tenants` itself); `coalition_members`
// maps shops into a coalition (tenant_id → RLS; the coalition service's cross-shop reads run through
// a validated bypass context and return PDPA-minimal fields only).
import { pgTable, bigserial, bigint, text, timestamp, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const coalitions = pgTable('coalitions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const coalitionMembers = pgTable('coalition_members', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  coalitionId: bigint('coalition_id', { mode: 'number' }).notNull().references(() => coalitions.id),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  active: boolean('active').notNull().default(true),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow(),
  createdBy: text('created_by'),
}, (t) => ({ uqShop: uniqueIndex('coalition_members_coalition_tenant').on(t.coalitionId, t.tenantId), idxTenant: index('coalition_members_tenant').on(t.tenantId) }));

export type Coalition = typeof coalitions.$inferSelect;
export type CoalitionMember = typeof coalitionMembers.$inferSelect;

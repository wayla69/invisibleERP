import { pgTable, bigserial, bigint, text, boolean, smallint, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const postingEventTypes = pgTable('posting_event_types', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
});

export const postingRules = pgTable('posting_rules', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  eventType: text('event_type').notNull().references(() => postingEventTypes.key),
  legOrder: smallint('leg_order').notNull(),
  role: text('role').notNull(),       // semantic slot: 'inventory', 'ap_control', 'cogs', 'vat_output', etc.
  side: text('side').notNull(),       // 'DR' or 'CR'
  accountCode: text('account_code').notNull(),
  dimensionSource: text('dimension_source'), // 'branch_id'|'project_id'|null — which ctx field to stamp
  condition: jsonb('condition'),      // optional filter e.g. {"category":"exempt"}
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqRule: uniqueIndex('uq_posting_rules').on(
    // Drizzle doesn't support COALESCE in index definitions — the raw SQL migration uses
    // COALESCE(tenant_id,0) for correct null-uniqueness. Here we just list the columns so
    // Drizzle knows the index exists.
    t.tenantId, t.eventType, t.legOrder,
  ),
}));

export type PostingRule = typeof postingRules.$inferSelect;
export type PostingEventType = typeof postingEventTypes.$inferSelect;

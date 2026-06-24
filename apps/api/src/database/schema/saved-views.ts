import { pgTable, bigserial, bigint, text, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Saved views — per-user, per-module saved filter/column/sort presets for list screens.
// Personal by default; `shared` makes a view visible to the whole tenant. Tenant-isolated via RLS.
export const savedViews = pgTable('saved_views', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  owner: text('owner').notNull(),          // username that created the view
  module: text('module').notNull(),        // list screen key, e.g. 'inventory' | 'orders'
  name: text('name').notNull(),
  config: jsonb('config').default({}),     // {filter:{...}, sort:'...', columns:[...]}
  shared: boolean('shared').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

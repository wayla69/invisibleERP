// E2 (Platform Phase 27) — data-migration toolkit. A migration_job records a dry-run: a source adapter
// (Loyverse / FlowAccount / generic CSV) maps a vendor export → canonical rows, then per-row validation
// (mirroring the Phase-7 importer) reports errors WITHOUT writing. The tenant previews, then commits through
// the proven Phase-7 import flow. RLS-scoped; validation only — no GL, no master-data writes here.
import { pgTable, bigserial, bigint, text, integer, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const migrationJobs = pgTable('migration_jobs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  source: text('source').notNull(),                 // csv | loyverse | flowaccount
  entity: text('entity').notNull(),                 // customers | products
  status: text('status').notNull().default('validated'),
  rowsTotal: integer('rows_total').default(0),
  rowsValid: integer('rows_valid').default(0),
  rowsError: integer('rows_error').default(0),
  detail: jsonb('detail').default({}),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type MigrationJob = typeof migrationJobs.$inferSelect;

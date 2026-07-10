// Store-hub → cloud replay tracking (docs/41 Phase 2a, control BRANCH-04; migration 0291).
// Lives on the HUB's database: one row per hub-captured sale — pushed / duplicate / failed /
// skipped_unsupported (the visible ledger of what could NOT be replayed, never a silent drop).
import { pgTable, bigserial, bigint, text, numeric, integer, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const hubPushLog = pgTable('hub_push_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  hubSaleNo: text('hub_sale_no').notNull(),        // the sale on THIS hub's ledger
  clientUuid: text('client_uuid').notNull(),       // deterministic idempotency key (hub:{tenant}:{hub_sale_no})
  status: text('status').notNull().default('pushed'), // pushed | duplicate | failed | skipped_unsupported
  cloudSaleNo: text('cloud_sale_no'),              // canonical sale_no minted by the cloud at ingest
  hubTotal: numeric('hub_total', { precision: 14, scale: 2 }),
  skipReason: text('skip_reason'),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  attempts: integer('attempts').notNull().default(1),
  pushedAt: timestamp('pushed_at', { withTimezone: true }).defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqSale: unique('uq_hub_push_sale').on(t.tenantId, t.hubSaleNo),
  byStatus: index('idx_hub_push_status').on(t.tenantId, t.status),
}));

export type HubPushLog = typeof hubPushLog.$inferSelect;

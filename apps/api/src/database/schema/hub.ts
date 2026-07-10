// Store-hub → cloud replay tracking (docs/41 Phase 2a/2c, controls BRANCH-04/BRANCH-05; migrations
// 0293 + 0296). Lives on the HUB's database: one row per hub-captured DOCUMENT — pushed / duplicate /
// failed / skipped_unsupported (the visible ledger of what could NOT be replayed, never a silent drop).
import { pgTable, bigserial, bigint, text, numeric, integer, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const hubPushLog = pgTable('hub_push_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  docType: text('doc_type').notNull().default('sale'), // sale | till (0296)
  hubSaleNo: text('hub_sale_no').notNull(),        // the sale (or, for doc_type='till', the session) on THIS hub
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

// Phase 4a — one row per hub box: liveness, replay backlog and clock skew, so a silent or stuck hub
// (quietly hoarding un-replayed cash) is visible to HQ and to the platform owner. Upserted by the
// hub's own signed heartbeat; `last_seen_at`/`clock_skew_sec` are stamped by the CLOUD's clock.
export const hubHeartbeats = pgTable('hub_heartbeats', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  hubId: text('hub_id').notNull(),
  appVersion: text('app_version'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastPushAt: timestamp('last_push_at', { withTimezone: true }),
  pendingSales: integer('pending_sales').notNull().default(0),
  pendingTills: integer('pending_tills').notNull().default(0),
  failedDocs: integer('failed_docs').notNull().default(0),
  skippedDocs: integer('skipped_docs').notNull().default(0),
  clockSkewSec: integer('clock_skew_sec'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqHub: unique('uq_hub_heartbeat').on(t.tenantId, t.hubId),
  bySeen: index('idx_hub_heartbeat_seen').on(t.tenantId, t.lastSeenAt),
}));

export type HubPushLog = typeof hubPushLog.$inferSelect;
export type HubHeartbeat = typeof hubHeartbeats.$inferSelect;

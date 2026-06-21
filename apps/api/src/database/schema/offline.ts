// POS Tier 2 #11 — Offline mode / sync (โหมดออฟไลน์ + ซิงค์). Idempotency ledger so a POS that sold
// while offline can replay its sales on reconnect without double-posting. One op per (tenant, client_uuid).
import { pgTable, bigserial, bigint, text, timestamp, integer, pgEnum } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const offlineSyncStatusEnum = pgEnum('offline_sync_status', ['synced', 'duplicate', 'failed']);

export const posOfflineSync = pgTable('pos_offline_sync', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  clientUuid: text('client_uuid').notNull(),          // client-generated idempotency key (UUID v4)
  deviceId: text('device_id'),                        // which POS device captured/queued the sale
  status: offlineSyncStatusEnum('status').default('synced'),
  saleNo: text('sale_no'),                            // server-minted SALE-… (NULL when failed)
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(), // ORIGINAL offline moment (client clock)
  syncedAt: timestamp('synced_at', { withTimezone: true }).defaultNow(),  // when the server posted it
  clientSeq: bigint('client_seq', { mode: 'number' }),// per-device monotonic counter (sequence audit)
  payloadHash: text('payload_hash'),                  // sha256 of the op payload (replay-tamper guard)
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  attempts: integer('attempts').default(1),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type PosOfflineSync = typeof posOfflineSync.$inferSelect;

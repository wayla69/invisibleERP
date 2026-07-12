import { pgTable, bigserial, bigint, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// G1 (docs/45) — marketplace-to-member identity map (MKT-13). One row per (tenant, platform, ref_hash):
// ref_hash = sha256 over `<platform>:<normalized external customer id|phone>`; the RAW marketplace
// identifier is never persisted (PDPA data-minimization). member_id stays NULL until the member links
// (QR self-service or staff link, both with explicit consent capture); once linked, every later ingest
// for the same ref auto-attaches dine_in_orders.member_id.
export const channelCustomerRefs = pgTable('channel_customer_refs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  platform: text('platform').notNull(), // grab | lineman | foodpanda | robinhood
  refHash: text('ref_hash').notNull(),
  memberId: bigint('member_id', { mode: 'number' }), // pos_members soft FK; NULL = not yet linked
  orderCount: bigint('order_count', { mode: 'number' }).notNull().default(1),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow(),
  lastOrderNo: text('last_order_no'),
  linkedAt: timestamp('linked_at', { withTimezone: true }),
  linkSource: text('link_source'), // qr | staff
  linkedBy: text('linked_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uq: uniqueIndex('uq_channel_customer_refs').on(t.tenantId, t.platform, t.refHash),
  byTenant: index('idx_channel_customer_refs_tenant').on(t.tenantId, t.memberId),
}));

export type ChannelCustomerRef = typeof channelCustomerRefs.$inferSelect;

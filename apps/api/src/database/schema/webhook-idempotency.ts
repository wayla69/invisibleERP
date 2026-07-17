import { pgTable, bigserial, bigint, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Platform-level inbound-webhook idempotency ledger (SOX-ICFR #5, migration 0429). Deliberately NOT
// tenant-scoped: the (source, idem_key) pair is globally unique, so there is no `tenant_id` column (which
// would force RLS + the tenant-idx gate and demand tenant context at claim time, though several webhook
// handlers run @NoTx before a tenant is resolved). `aboutTenantId` is informational only and, per the
// platform-table convention, is intentionally not named `tenant_id` so the RLS loop and tenant-idx gate
// skip it.
export const webhookIdempotency = pgTable(
  'webhook_idempotency',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source: text('source').notNull(),
    idemKey: text('idem_key').notNull(),
    aboutTenantId: bigint('about_tenant_id', { mode: 'number' }).references(() => tenants.id),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('uq_webhook_idempotency').on(t.source, t.idemKey),
    received: index('idx_webhook_idempotency_received').on(t.receivedAt),
  }),
);

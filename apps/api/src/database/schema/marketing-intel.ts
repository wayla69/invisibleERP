import { pgTable, bigserial, bigint, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Marketing Intelligence push-back store (migration 0460, docs/48 phase 3).
// The standalone Python Marketing Intelligence Platform computes advanced MMM / Sentiment-Weighted RFM /
// TOWS in its own data warehouse and pushes the results back into the ERP over the public API
// (scope analytics:write). The ERP then OWNS the data it renders at /marketing-intel — no cross-database
// join (DB-isolation rule), and the page works even when the external platform is offline.
//
// One row per (tenant, kind); the writer upserts the LATEST snapshot per kind (unique index in 0460).
// Tenant-scoped: 0460 applies the canonical 0232-form org RLS loop + the leading (tenant_id, kind) index.
export const miAnalyticsSnapshots = pgTable('mi_analytics_snapshots', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  kind: text('kind').notNull(), // mmm | rfm | tows
  payload: jsonb('payload').notNull().default({}),
  modelRunRef: text('model_run_ref'),
  source: text('source').notNull().default('mi-platform'),
  pushedBy: text('pushed_by'),
  pushedAt: timestamp('pushed_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ byTenantKind: index('idx_mi_snapshots_tenant').on(t.tenantId, t.kind) }));

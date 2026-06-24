// D2 (Platform Phase 24) — connector framework. Inbound integrations over a canonical model. A connector
// holds (stub) config; a sync pulls a canonical batch and dedupes via external_id_map (idempotent); every run
// is logged. Imported data is surfaced as canonical records for review — it NEVER auto-posts to AR/AP/GL.
// Real adapters would store OAuth creds AES-256-GCM-encrypted (the tenant_identity pattern); the stub default
// is what CI exercises. RLS-scoped.
import { pgTable, bigserial, bigint, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const connectors = pgTable('connectors', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  type: text('type').notNull(),                                 // line | shopee | bank_csv
  label: text('label'),
  status: text('status').notNull().default('connected'),        // connected | disabled
  config: jsonb('config').default({}),                          // non-secret config (real creds would be encrypted)
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const connectorSyncs = pgTable('connector_syncs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  connectorId: bigint('connector_id', { mode: 'number' }),
  status: text('status').notNull(),                             // ok | error
  pulled: bigint('pulled', { mode: 'number' }).default(0),
  createdCount: bigint('created_count', { mode: 'number' }).default(0),
  detail: text('detail'),
  ranAt: timestamp('ran_at', { withTimezone: true }).defaultNow(),
});

export const externalIdMap = pgTable('external_id_map', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  connectorType: text('connector_type').notNull(),
  canonicalType: text('canonical_type').notNull(),             // order | product | statement_line
  externalId: text('external_id').notNull(),
  localRef: text('local_ref'),
  seenAt: timestamp('seen_at', { withTimezone: true }).defaultNow(),
});

export type Connector = typeof connectors.$inferSelect;

import { pgTable, bigserial, bigint, text, integer, timestamp, boolean, jsonb, index, primaryKey } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { roleEnum } from './enums';

export const notifications = pgTable('notifications', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  targetTenantId: bigint('target_tenant_id', { mode: 'number' }).references(() => tenants.id),
  targetRole: roleEnum('target_role'),
  message: text('message'), // Thai
  messageEn: text('message_en'),
  isRead: boolean('is_read').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// polymorphic audit (แทน _log_status)
export const docStatusLog = pgTable('doc_status_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  docType: text('doc_type'),
  docNo: text('doc_no'),
  oldStatus: text('old_status'),
  newStatus: text('new_status'),
  changedBy: text('changed_by'),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow(),
  remarks: text('remarks'),
});

// คุมรูปแบบเลขเอกสาร
export const docNumberConfig = pgTable('doc_number_config', {
  docType: text('doc_type').primaryKey(),
  format: text('format').notNull(),
});

// atomic per-(doc_type, day) counter — แก้ race ของ COUNT(*)+1 ใน V1 (upsert-returning)
export const docCounters = pgTable(
  'doc_counters',
  {
    docType: text('doc_type').notNull(),
    day: text('day').notNull(),
    n: integer('n').notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.docType, t.day] }) }),
);

// Append-only audit log (move #4) — tamper-evident trail of mutations (who/what/when/tenant/trace)
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: timestamp('ts', { withTimezone: true }).defaultNow(),
    actor: text('actor'),
    tenantId: bigint('tenant_id', { mode: 'number' }),
    action: text('action'), // METHOD /route
    entity: text('entity'),
    entityId: text('entity_id'),
    ip: text('ip'),
    requestId: text('request_id'),
    traceId: text('trace_id'),
    status: text('status'), // success | fail
    meta: jsonb('meta'),
  },
  (t) => ({ byActor: index('idx_audit_actor').on(t.actor), byTs: index('idx_audit_ts').on(t.ts) }),
);

// Public API keys (move #7) — scoped, hashed
export const apiKeys = pgTable('api_keys', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  name: text('name'),
  prefix: text('prefix').notNull(), // shown to user (first 8 chars)
  hashedKey: text('hashed_key').notNull(),
  scopes: text('scopes').default(''), // csv of scopes
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revoked: boolean('revoked').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Outbound webhooks (move #7) — signed, retryable
export const webhooks = pgTable('webhooks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  url: text('url').notNull(),
  events: text('events').default(''), // csv of event names
  secret: text('secret').notNull(),
  active: boolean('active').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  webhookId: bigint('webhook_id', { mode: 'number' }).references(() => webhooks.id),
  event: text('event'),
  payload: jsonb('payload'),
  status: text('status').default('pending'), // pending | delivered | failed
  statusCode: integer('status_code'),
  attempts: integer('attempts').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

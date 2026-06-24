import { pgTable, bigserial, bigint, text, integer, timestamp, boolean, jsonb, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
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

// Per-user read state for the notification inbox. notifications.is_read is a single
// shared boolean (wrong when a (tenant, role) notification has many recipients); this
// table records who has read which notification. No tenant_id → not RLS-scoped; the
// inbox query scopes rows by joining to notifications and filters by the caller's own
// username, so a user only ever sees/writes their own markers.
export const notificationReads = pgTable(
  'notification_reads',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    notificationId: bigint('notification_id', { mode: 'number' })
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('uq_notification_reads').on(t.notificationId, t.username),
    byUser: index('idx_notification_reads_username').on(t.username),
  }),
);

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

// atomic per-(doc_type, tenant, YYYYMM) counter — for tax-doc numbers that must be
// SEQUENTIAL PER SELLER (legal requirement, ม.86/4(4)). tenant_id → covered by RLS loop.
export const docCountersTenant = pgTable(
  'doc_counters_tenant',
  {
    docType: text('doc_type').notNull(),
    tenantId: bigint('tenant_id', { mode: 'number' }).notNull(),
    period: text('period').notNull(), // 'YYYYMM'
    n: integer('n').notNull().default(0),
  },
  (t) => ({ pk: primaryKey({ columns: [t.docType, t.tenantId, t.period] }) }),
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
  (t) => ({
    byActor: index('idx_audit_actor').on(t.actor),
    byTs: index('idx_audit_ts').on(t.ts),
    // composite indexes for the tenant-scoped audit-trail viewer (Phase 6) — keep in sync with 0083
    byTenantTs: index('idx_audit_tenant_ts').on(t.tenantId, t.ts),
    byTenantActor: index('idx_audit_tenant_actor').on(t.tenantId, t.actor),
    byTenantAction: index('idx_audit_tenant_action').on(t.tenantId, t.action),
    byTenantStatus: index('idx_audit_tenant_status').on(t.tenantId, t.status),
  }),
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
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// Module enable/disable — system-wide feature flags (admin toggles whole
// modules on/off; disabled modules vanish from nav + blocked at the API).
// Global on purpose (no tenant_id → no RLS): a platform-wide switch, mirroring
// the legacy ERPPOS tbl_module_config. module_key == permission key.
export const moduleConfigs = pgTable('module_configs', {
  moduleKey: text('module_key').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  updatedBy: text('updated_by'),
});

// Per-tenant enterprise identity config (Platform #4): OIDC SSO + SCIM 2.0 provisioning.
// tenant_id → RLS-scoped (0088 re-runs the loop). Secrets are never returned in plaintext after write.
export const tenantIdentity = pgTable('tenant_identity', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  ssoEnabled: boolean('sso_enabled').notNull().default(false),
  oidcIssuer: text('oidc_issuer'),
  oidcClientId: text('oidc_client_id'),
  oidcClientSecretEnc: text('oidc_client_secret_enc'), // AES-256-GCM at rest
  oidcRedirectUri: text('oidc_redirect_uri'),
  defaultRole: text('default_role').notNull().default('Customer'),
  scimEnabled: boolean('scim_enabled').notNull().default(false),
  scimTokenHash: text('scim_token_hash'),     // sha256(scim_…); plaintext shown once
  scimTokenPrefix: text('scim_token_prefix'), // first 12 chars for display
  updatedBy: text('updated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  webhookId: bigint('webhook_id', { mode: 'number' }).references(() => webhooks.id),
  event: text('event'),
  payload: jsonb('payload'),
  status: text('status').default('pending'), // pending | delivered | failed
  statusCode: integer('status_code'),
  attempts: integer('attempts').default(0),
  error: text('error'),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

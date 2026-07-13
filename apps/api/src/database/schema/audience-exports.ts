import { pgTable, bigserial, bigint, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// G3 (docs/45) — append-only register of hashed-audience exports (PDPA-05). One row per audience_export_sync
// attempt: the consent basis it filtered on, considered/consented/pushed counts, the target, and the ACTIVE
// ROPA activity it ran under. A run without that ROPA row is recorded status='blocked' (fail-closed).
export const audienceExports = pgTable('audience_exports', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  purpose: text('purpose').notNull().default('marketing'),
  consentBasis: text('consent_basis').notNull().default('member_consents:marketing'),
  target: text('target').notNull(), // webhook | mock
  hashAlg: text('hash_alg').notNull().default('sha256'),
  membersConsidered: bigint('members_considered', { mode: 'number' }).notNull().default(0),
  membersConsented: bigint('members_consented', { mode: 'number' }).notNull().default(0),
  rowsPushed: bigint('rows_pushed', { mode: 'number' }).notNull().default(0),
  rowsRemoved: bigint('rows_removed', { mode: 'number' }).notNull().default(0),
  status: text('status').notNull(), // success | failed | blocked
  error: text('error'),
  ropaActivityId: bigint('ropa_activity_id', { mode: 'number' }), // ropa_activities soft FK; NULL only when blocked
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_audience_exports_tenant').on(t.tenantId, t.createdAt),
}));

export type AudienceExport = typeof audienceExports.$inferSelect;

// Depth follow-up (extends PDPA-05): the upload MANIFEST — which member hashes are currently uploaded to
// the external audiences. Hash-only + member_id (minimization unchanged); captured at upload time so a
// later DSAR erasure (which nulls phone/email) cannot orphan the removal. removed_at stamps the pruned rows.
export const audienceExportMembers = pgTable('audience_export_members', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).notNull(), // pos_members soft FK
  hashedEmail: text('hashed_email'),
  hashedPhone: text('hashed_phone'),
  hashedPhonePlus: text('hashed_phone_plus'),
  lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
  removedAt: timestamp('removed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uq: uniqueIndex('uq_audience_export_members').on(t.tenantId, t.memberId),
  byTenant: index('idx_audience_export_members_tenant').on(t.tenantId, t.removedAt),
}));

export type AudienceExportMember = typeof audienceExportMembers.$inferSelect;

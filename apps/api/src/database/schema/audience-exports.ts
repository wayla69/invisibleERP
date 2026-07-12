import { pgTable, bigserial, bigint, text, timestamp, index } from 'drizzle-orm/pg-core';
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
  status: text('status').notNull(), // success | failed | blocked
  error: text('error'),
  ropaActivityId: bigint('ropa_activity_id', { mode: 'number' }), // ropa_activities soft FK; NULL only when blocked
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_audience_exports_tenant').on(t.tenantId, t.createdAt),
}));

export type AudienceExport = typeof audienceExports.$inferSelect;

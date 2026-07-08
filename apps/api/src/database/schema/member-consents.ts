// CRM Phase 1 — PDPA per-purpose consent ledger for loyalty members.
// Supersedes the single pos_members.marketing_opt_in boolean (kept in sync for back-compat): one row per
// (member, purpose). tenant_id REQUIRED → RLS. Append-friendly: granted_at / withdrawn_at audit the change.
import { pgTable, bigserial, bigint, text, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';

export const memberConsents = pgTable('member_consents', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  purpose: text('purpose').notNull(),        // marketing | profiling | line | sms | email | dining_profile
  channel: text('channel'),                  // optional sub-channel
  granted: boolean('granted').notNull().default(true),
  source: text('source'),                    // pos | portal | import | admin
  grantedAt: timestamp('granted_at', { withTimezone: true }),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  createdBy: text('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqPurpose: uniqueIndex('member_consents_member_purpose').on(t.memberId, t.purpose),
  idxTenant: index('idx_member_consents_tenant').on(t.tenantId),
}));

export type MemberConsent = typeof memberConsents.$inferSelect;

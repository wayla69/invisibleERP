import { pgTable, bigserial, bigint, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { encryptedText } from '../encrypted-column';

// GRC-3 — Sensitive master-data single-record maker-checker (control MDM-01, migration 0340).
// The bulk master-data import already had a maker-checker (masterdata_import_batches, G5/G7/G8) and a
// vendor's bank_name/bank_account got a dedicated dual-control in 0270 (vendor_bank_change_requests). But a
// NORMAL single-record UI/CRUD edit of a SENSITIVE vendor field — its credit limit, its payment terms, or
// the payee account-holder name (bank_account_name, added in 0340) — still wrote the master directly with no
// second check. Redirecting a supplier's payee details is the classic disbursement-fraud / BEC vector, so
// this stages such an edit as `pending` and applies it to the entity ONLY when a DISTINCT user approves it
// (approved_by ≠ requested_by → 403 SOD_SELF_APPROVAL). Reject discards it; the master is untouched.
//
// Generic by design (entity_type vendor | customer | item, a field name, and the before/after value) so the
// same queue governs future entities/fields. old_value/new_value are `encryptedText` — a staged bank value
// is a payment-redirection secret and must not sit in plaintext at rest (matches the 0270 precedent).
// tenant_id is nullable — mirrors vendors.tenant_id (a shared/legacy master row has no tenant_id); the
// canonical org-scoped RLS loop still isolates non-bypass access correctly.
export const masterdataChangeRequests = pgTable('masterdata_change_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  reqNo: text('req_no').notNull(),
  entityType: text('entity_type').notNull(),  // vendor | customer | item
  entityId: bigint('entity_id', { mode: 'number' }).notNull(),
  field: text('field').notNull(),             // logical field key (e.g. credit_limit, payment_terms, bank_account_name)
  oldValue: encryptedText('old_value'),        // captured for the audit trail (encrypted at rest)
  newValue: encryptedText('new_value'),        // requested value (encrypted at rest)
  status: text('status').notNull().default('pending'), // pending | approved | rejected
  reason: text('reason'),                      // maker's justification
  requestedBy: text('requested_by'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
}, (t) => ({
  uqMdcNo: unique('uq_masterdata_change_no').on(t.reqNo),
  // Tenant-leading index (docs/27 R1-1/AUD-ARC-01) — the pending-queue read filters by tenant + status.
  idxMdcTenant: index('idx_masterdata_change_tenant').on(t.tenantId, t.status),
  idxMdcEntity: index('idx_masterdata_change_entity').on(t.entityType, t.entityId),
}));

export type MasterdataChangeRequest = typeof masterdataChangeRequests.$inferSelect;

import { pgTable, bigserial, bigint, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// G15 (maker-checker audit): a change to a tenant's payment-receiving / legal-identity fields — the
// PromptPay merchant id (which target RECEIVES customer QR payments) and the Tax ID (legal identity on
// issued tax invoices) — is staged here as PendingApproval and applied only when a DISTINCT approver
// releases it, so a single admin cannot silently redirect incoming customer payments. tenant_id is the
// owning tenant (tenant-scoped → RLS + a leading (tenant_id, …) index; see migration 0265).
export const tenantProfileChangeRequests = pgTable('tenant_profile_change_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  reqNo: text('req_no').notNull(),
  promptpayId: text('promptpay_id'),          // requested new value (null = not changing this field)
  taxId: text('tax_id'),
  prevPromptpayId: text('prev_promptpay_id'),  // captured for the audit trail
  prevTaxId: text('prev_tax_id'),
  status: text('status').notNull().default('PendingApproval'),
  requestedBy: text('requested_by'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
}, (t) => ({
  uqTpcNo: unique('uq_tenant_profile_change_no').on(t.tenantId, t.reqNo),
  idxTpcStatus: index('idx_tenant_profile_change_status').on(t.tenantId, t.status),
}));

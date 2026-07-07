import { pgTable, bigserial, bigint, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { vendors } from './procurement';
import { tenants } from './tenants';
import { encryptedText } from '../encrypted-column';

// Master-data audit (0270) — a vendor's bank_name/bank_account had NO dual control: a single md_vendor
// user could redirect a supplier's payee bank details with no second check, a classic Business-Email-
// Compromise / vendor-payment-fraud vector (unlike the company's OWN bank_accounts, which already got
// maker-checker in 0264, and the tenant PromptPay/tax-id G15 pattern in tenant_profile_change_requests).
// This mirrors that exact G15 shape: a bank-detail change is staged PendingApproval and applied only when
// a DISTINCT approver releases it. bankAccount/prevBankAccount are encrypted to match the sensitivity
// already established on vendors.bank_account. tenantId is nullable — mirrors vendors.tenant_id (a shared/
// legacy vendor row has no tenant_id either); the generic RLS loop still scopes non-bypass access correctly.
export const vendorBankChangeRequests = pgTable('vendor_bank_change_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  vendorId: bigint('vendor_id', { mode: 'number' }).notNull().references(() => vendors.id),
  reqNo: text('req_no').notNull(),
  bankName: text('bank_name'),            // requested new value (null = not changing this field)
  bankAccount: encryptedText('bank_account'),
  prevBankName: text('prev_bank_name'),   // captured for the audit trail
  prevBankAccount: encryptedText('prev_bank_account'),
  status: text('status').notNull().default('PendingApproval'),
  requestedBy: text('requested_by'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
}, (t) => ({
  uqVbcNo: unique('uq_vendor_bank_change_no').on(t.vendorId, t.reqNo),
  idxVbcStatus: index('idx_vendor_bank_change_status').on(t.vendorId, t.status),
  // Tenant-leading index (docs/27 R1-1/AUD-ARC-01) — the natural lookups above are vendor-scoped.
  idxVbcTenant: index('idx_vendor_bank_change_tenant').on(t.tenantId),
}));

export type VendorBankChangeRequest = typeof vendorBankChangeRequests.$inferSelect;

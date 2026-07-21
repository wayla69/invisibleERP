import { bigint, bigserial, index, numeric, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// SaaS payment claims (wave C, migration 0458). Platform-level (about_tenant_id — NOT tenant_id, so the
// RLS loop + tenant-index guard skip it, mirroring saas_receipts). One row per bank-transfer/PromptPay
// slip a tenant submits for its subscription: Pending until a platform owner verifies the money actually
// arrived — approve records the A4 saas_receipt (idempotent on `claim:<id>`) + re-activates the
// subscription; reject emails the reason. (about_tenant_id, slip_ref) UNIQUE stops the same slip being
// filed twice by one company.
export const saasPaymentClaims = pgTable('saas_payment_claims', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  aboutTenantId: bigint('about_tenant_id', { mode: 'number' }).notNull(),
  amount: numeric('amount', { precision: 12, scale: 2 }).notNull(), // THB the customer says they transferred
  period: text('period'), // YYYY-MM the payment is for
  slipRef: text('slip_ref').notNull(), // bank/PromptPay transfer reference the slip shows
  note: text('note'),
  status: text('status').notNull().default('Pending'), // 'Pending' | 'Approved' | 'Rejected'
  receiptNo: text('receipt_no'), // stamped on approve (the A4 receipt issued for this claim)
  rejectReason: text('reject_reason'),
  createdBy: text('created_by').notNull(),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bySlip: uniqueIndex('saas_payment_claims_slip_uq').on(t.aboutTenantId, t.slipRef),
  byTenant: index('saas_payment_claims_tenant_idx').on(t.aboutTenantId, t.createdAt),
  byStatus: index('saas_payment_claims_status_idx').on(t.status, t.createdAt),
}));

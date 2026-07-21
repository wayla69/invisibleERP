import { bigint, bigserial, index, numeric, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

// Own-SaaS receipts (A4, migration 0454) — the platform's receipt/ใบเสร็จ ledger for SUBSCRIPTION money it
// collects (Stripe invoice payments + god-recorded bank transfers). Platform-level: about_tenant_id (NOT
// tenant_id — RLS loop + tenant-index guard skip it, mirroring platform_emails). source_ref is the
// idempotency anchor (a re-delivered Stripe webhook or a retried manual record converges to one receipt).
// NB: this is the PLATFORM's own revenue paper trail — completely separate from tenant AR receipts.
export const saasReceipts = pgTable('saas_receipts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  receiptNo: text('receipt_no').notNull(),
  aboutTenantId: bigint('about_tenant_id', { mode: 'number' }).notNull(),
  source: text('source').notNull(), // 'stripe_invoice' | 'manual'
  sourceRef: text('source_ref').notNull(), // stripe invoice id, or MANUAL-<uuid>
  period: text('period'), // YYYY-MM the charge covers (best effort)
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(), // VAT-inclusive THB
  vatAmount: numeric('vat_amount', { precision: 14, scale: 2 }), // 7/107 breakdown when the issuer is VAT-registered; NULL = plain receipt
  currency: text('currency').notNull().default('THB'),
  note: text('note'),
  createdBy: text('created_by').notNull(), // 'stripe (auto)' | the recording god username
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bySourceRef: uniqueIndex('saas_receipts_source_ref_uq').on(t.sourceRef),
  byReceiptNo: uniqueIndex('saas_receipts_no_uq').on(t.receiptNo),
  byTenant: index('saas_receipts_tenant_idx').on(t.aboutTenantId, t.createdAt),
}));

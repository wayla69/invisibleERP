// LYL-17 — receipt-upload-for-points (member submits a photo of a purchase made outside our POS; staff
// reviews & approves/rejects before points are granted). Points post through the existing earnInTx path
// (member.service.ts) on approval, so no separate GL logic lives here — this table is the review queue.
import { pgTable, bigserial, bigint, text, numeric, timestamp, date, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';

export const loyaltyReceiptSubmissions = pgTable('loyalty_receipt_submissions', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  receiptImage: text('receipt_image').notNull(),          // data:image/* URL (mirrors item-images.ts, no S3)
  purchaseAmount: numeric('purchase_amount').notNull(),
  storeName: text('store_name'),
  purchaseDate: date('purchase_date'),
  note: text('note'),
  claimedPointsPreview: numeric('claimed_points_preview').default('0'), // informational only; real points computed at approval
  status: text('status').notNull().default('Pending'),     // Pending | Approved | Rejected
  submittedAt: timestamp('submitted_at', { withTimezone: true }).defaultNow(),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
  refDoc: text('ref_doc'),                                  // pos_member_ledger tie-out once approved (RCT-<id>)
  createdBy: text('created_by'),
}, (t) => ({
  idxTenantStatus: index('loyalty_receipt_submissions_tenant_status').on(t.tenantId, t.status),
  // Same (member, purchase_date, purchase_amount) can't be claimed twice while a submission is live —
  // a rejected one frees the slot so a corrected resubmission is still possible.
  uqDuplicateClaim: uniqueIndex('loyalty_receipt_submissions_dup_guard')
    .on(t.tenantId, t.memberId, t.purchaseDate, t.purchaseAmount)
    .where(sql`${t.status} <> 'Rejected'`),
}));

export type LoyaltyReceiptSubmission = typeof loyaltyReceiptSubmissions.$inferSelect;

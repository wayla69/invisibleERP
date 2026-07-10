// POS Tier 2 #9 — Loyalty / membership at POS (สมาชิก/แต้มที่จุดขาย).
// End-consumer members per shop (distinct from tenant-scoped loyalty_points) + append-only points ledger.
// tenant_id REQUIRED → RLS: each shop owns its own roster. Lookup by phone / card / member_code.
import { pgTable, bigserial, bigint, text, numeric, timestamp, boolean, date, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const posMembers = pgTable('pos_members', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberCode: text('member_code').notNull(),       // M-000123
  name: text('name'),
  phone: text('phone'),
  cardNo: text('card_no'),
  email: text('email'),
  // LINE OA identity (the dominant Thai channel). lineUserId is the stable `sub` from LINE Login/LIFF —
  // the address LINE push messages are sent to. Unique per tenant so one LINE account = one member.
  lineUserId: text('line_user_id'),
  lineDisplayName: text('line_display_name'),
  birthday: date('birthday'),                       // for birthday campaigns (month/day matter)
  marketingOptIn: boolean('marketing_opt_in').notNull().default(true), // consent for marketing messages
  balance: numeric('balance').default('0'),
  lifetime: numeric('lifetime').default('0'),
  tier: text('tier').default('Standard'),
  active: boolean('active').default(true),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).defaultNow(),
  lastUpdated: timestamp('last_updated', { withTimezone: true }),
  createdBy: text('created_by'),
}, (t) => ({
  uqCode: uniqueIndex('pos_members_tenant_code').on(t.tenantId, t.memberCode),
  // NULL line_user_id rows are distinct under a Postgres unique index, so unlinked members never collide.
  uqLine: uniqueIndex('pos_members_tenant_line').on(t.tenantId, t.lineUserId),
}));

// Message-delivery log for CRM messaging (LINE / SMS / email). Provider-agnostic; mock by default.
export const messageLog = pgTable('message_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  channel: text('channel').notNull(),               // line | sms | email
  recipient: text('recipient'),
  body: text('body').notNull(),
  campaign: text('campaign'),
  status: text('status').notNull(),                 // sent | failed | skipped | delivered | undelivered
  provider: text('provider'),                       // mock | line | sms | email
  providerRef: text('provider_ref'),                // provider message id — correlates a delivery-status callback
  error: text('error'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ idxTenant: index('idx_message_log_tenant').on(t.tenantId, t.createdAt) }));
// phone/card partial-unique (WHERE NOT NULL) defined in the migration SQL.

export const posMemberLedger = pgTable('pos_member_ledger', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  txnDate: timestamp('txn_date', { withTimezone: true }).defaultNow(),
  txnType: text('txn_type'),                       // 'Earn' | 'Redeem' | 'Adjust'
  points: numeric('points'),                       // signed
  redeemValue: numeric('redeem_value', { precision: 14, scale: 2 }).default('0'),
  balanceAfter: numeric('balance_after'),
  refDoc: text('ref_doc'),
  notes: text('notes'),
  createdBy: text('created_by'),
}, (t) => ({ idxMember: index('pos_member_ledger_member').on(t.memberId), idxRef: index('pos_member_ledger_ref').on(t.refDoc) }));
// Migration 0315 additionally creates the PARTIAL unique index `uq_member_ledger_doc` on
// (tenant_id, member_id, ref_doc, txn_type) WHERE ref_doc IS NOT NULL AND txn_type IN ('Earn','Redeem')
// — replay safety for the points ledger (LYL-22). drizzle-kit cannot express a partial unique index, so
// it lives in the migration only; do not "clean it up" by regenerating the snapshot.

// W1 (docs/27) — idempotency register for the loyalty.points_expiring look-ahead event: one notice per
// member × expire-by date, so a daily maintenance sweep never re-nags the member about the same batch.
export const loyaltyExpiryNotices = pgTable('loyalty_expiry_notices', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberId: bigint('member_id', { mode: 'number' }).notNull().references(() => posMembers.id),
  expireBy: date('expire_by').notNull(),
  expiringPoints: numeric('expiring_points', { precision: 14, scale: 2 }).notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqWindow: uniqueIndex('loyalty_expiry_notices_member_window').on(t.memberId, t.expireBy), idxTenant: index('loyalty_expiry_notices_tenant').on(t.tenantId) }));

// G13 (maker-checker audit): a staff-initiated P2P point transfer ABOVE the approval threshold is a
// point-value move to another member (a TFRS-15 liability) — potential self-enrichment (R15/R16) — so it is
// STAGED here as PendingApproval (no points move) and executed only when a DISTINCT approver releases it.
// Sub-threshold transfers still move immediately to keep the counter fast (mirrors the gift-card threshold).
export const pendingPointTransfers = pgTable('pending_point_transfers', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).notNull().references(() => tenants.id),
  reqNo: text('req_no').notNull(),
  fromMemberId: bigint('from_member_id', { mode: 'number' }).notNull().references(() => posMembers.id),
  toMemberId: bigint('to_member_id', { mode: 'number' }).notNull().references(() => posMembers.id),
  points: numeric('points').notNull(),
  note: text('note'),
  status: text('status').notNull().default('PendingApproval'), // PendingApproval | Approved | Rejected
  requestedBy: text('requested_by'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),                              // checker — must differ from requester
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
}, (t) => ({ uqPptNo: uniqueIndex('uq_pending_point_transfer_no').on(t.tenantId, t.reqNo), idxPptStatus: index('idx_pending_point_transfer_status').on(t.tenantId, t.status) }));

export type PosMember = typeof posMembers.$inferSelect;
export type PosMemberLedger = typeof posMemberLedger.$inferSelect;
export type MessageLog = typeof messageLog.$inferSelect;

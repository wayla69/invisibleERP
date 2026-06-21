// POS Tier 2 #9 — Loyalty / membership at POS (สมาชิก/แต้มที่จุดขาย).
// End-consumer members per shop (distinct from tenant-scoped loyalty_points) + append-only points ledger.
// tenant_id REQUIRED → RLS: each shop owns its own roster. Lookup by phone / card / member_code.
import { pgTable, bigserial, bigint, text, numeric, timestamp, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const posMembers = pgTable('pos_members', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  memberCode: text('member_code').notNull(),       // M-000123
  name: text('name'),
  phone: text('phone'),
  cardNo: text('card_no'),
  email: text('email'),
  balance: numeric('balance').default('0'),
  lifetime: numeric('lifetime').default('0'),
  tier: text('tier').default('Standard'),
  active: boolean('active').default(true),
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).defaultNow(),
  lastUpdated: timestamp('last_updated', { withTimezone: true }),
  createdBy: text('created_by'),
}, (t) => ({ uqCode: uniqueIndex('pos_members_tenant_code').on(t.tenantId, t.memberCode) }));
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

export type PosMember = typeof posMembers.$inferSelect;
export type PosMemberLedger = typeof posMemberLedger.$inferSelect;

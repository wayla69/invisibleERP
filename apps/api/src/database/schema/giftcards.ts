// POS Tier 2 #7 — Gift cards / store credit (บัตรของขวัญ / เครดิตร้านค้า).
// A card is a 2200 Customer-Deposits liability: cash in at issue, drawn down when redeemed as a
// tender, topped up by store-credit refunds. tenant_id REQUIRED → RLS: each shop owns its own cards.
import { pgTable, bigserial, bigint, text, numeric, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const giftCardStatusEnum = pgEnum('gift_card_status', ['Active', 'Redeemed', 'Void']);
export const giftCardTxnTypeEnum = pgEnum('gift_card_txn_type', ['Issue', 'Redeem', 'Refund', 'Void']);

export const giftCards = pgTable('gift_cards', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  cardNo: text('card_no').notNull().unique(),                   // GC-YYYYMMDD-NNN
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  initialAmount: numeric('initial_amount', { precision: 14, scale: 2 }).notNull(),
  balance: numeric('balance', { precision: 14, scale: 2 }).notNull(),
  currency: text('currency').default('THB'),
  status: giftCardStatusEnum('status').default('Active'),
  issuedSaleNo: text('issued_sale_no'),                         // sale where sold (issue) — null for refund-credit
  note: text('note'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Append-only ledger of every balance change (audit + balance_after, mirrors cust_stock_log).
export const giftCardTxns = pgTable('gift_card_txns', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  txnNo: text('txn_no').notNull().unique(),                     // GCT-YYYYMMDD-NNN
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  cardNo: text('card_no').notNull(),
  type: giftCardTxnTypeEnum('type').notNull(),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(), // +issue/+refund, -redeem (signed)
  balanceAfter: numeric('balance_after', { precision: 14, scale: 2 }).notNull(),
  refDoc: text('ref_doc'),                                      // sale_no / return_no
  journalNo: text('journal_no'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export type GiftCard = typeof giftCards.$inferSelect;
export type GiftCardTxn = typeof giftCardTxns.$inferSelect;

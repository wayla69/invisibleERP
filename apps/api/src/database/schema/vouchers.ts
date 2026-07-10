// POS-3 (docs/41) — standalone campaign voucher/coupon codes redeemable at checkout. A voucher CAMPAIGN
// carries the discount spec (kind/value mirror the promo/pricing shapes: percent | amount), the validity
// window + min-spend/channel gates, per-code use policy and an optional campaign-wide redemption cap.
// CODES are crypto-random, unique per tenant, with a one-way state lifecycle (issued → redeemed | void)
// mirroring the gift-card / member-coupon pattern. Campaign activation is maker-checker (REV-20, mirrors
// the price-rule G6 gate): created 'PendingApproval' — the checkout redemption path reads only 'Active'
// campaigns — and a DIFFERENT user activates it. tenant_id on both tables → RLS (migration 0292).
import { pgTable, bigserial, bigint, text, numeric, integer, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const voucherCampaigns = pgTable('voucher_campaigns', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  campaignCode: text('campaign_code').notNull(),             // VCH-YYYYMMDD-NNN
  name: text('name').notNull(),
  kind: text('kind').notNull().default('percent'),           // percent | amount (order-level discount)
  value: numeric('value', { precision: 14, scale: 2 }).notNull().default('0'),
  minSpend: numeric('min_spend', { precision: 14, scale: 2 }),          // null = no floor
  channel: text('channel').default('any'),                   // any | dine_in | takeaway | delivery
  validFrom: date('valid_from'),
  validTo: date('valid_to'),
  perCodeMaxUses: integer('per_code_max_uses').notNull().default(1),    // 1 = single-use codes
  maxRedemptions: integer('max_redemptions'),                // campaign-wide cap (null = unlimited)
  status: text('status').notNull().default('PendingApproval'), // PendingApproval | Active | Rejected | Ended
  codesIssued: integer('codes_issued').notNull().default(0),
  redeemedCount: integer('redeemed_count').notNull().default(0),
  createdBy: text('created_by'),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqCode: uniqueIndex('voucher_campaigns_tenant_code').on(t.tenantId, t.campaignCode),
  idxStatus: index('voucher_campaigns_tenant_status').on(t.tenantId, t.status),
}));

export const voucherCodes = pgTable('voucher_codes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  campaignId: bigint('campaign_id', { mode: 'number' }).notNull().references(() => voucherCampaigns.id),
  code: text('code').notNull(),                              // unique per tenant
  state: text('state').notNull().default('issued'),          // issued | redeemed | void
  useCount: integer('use_count').notNull().default(0),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  redeemedBy: text('redeemed_by'),
  saleRef: text('sale_ref'),                                 // sale_no of the (last) redeeming sale
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedBy: text('voided_by'),
  voidReason: text('void_reason'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqCode: uniqueIndex('voucher_codes_tenant_code').on(t.tenantId, t.code),
  idxCampaign: index('voucher_codes_tenant_campaign').on(t.tenantId, t.campaignId),
  idxState: index('voucher_codes_tenant_state').on(t.tenantId, t.state),
}));

export type VoucherCampaign = typeof voucherCampaigns.$inferSelect;
export type VoucherCode = typeof voucherCodes.$inferSelect;

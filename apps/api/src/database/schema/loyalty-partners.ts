// CRM Phase 4 — partner privileges. Member-facing perks at partner merchants (tier-gated discounts / freebies
// / access). A member claims a privilege → gets a single-use claim code → the partner marks it used. Reuses
// the points-ledger NOT involved (privileges are non-points perks), but mirrors the rewards single-use model.
// tenant_id REQUIRED → RLS.
import { pgTable, bigserial, bigint, text, numeric, integer, timestamp, boolean, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';

export const loyaltyPartners = pgTable('loyalty_partners', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  partnerCode: text('partner_code').notNull(),            // PTR-… (unique per tenant)
  name: text('name').notNull(),
  category: text('category'),                             // dining | retail | travel | wellness | …
  contact: text('contact'),
  active: boolean('active').default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqCode: uniqueIndex('loyalty_partners_tenant_code').on(t.tenantId, t.partnerCode) }));

export const loyaltyPrivileges = pgTable('loyalty_privileges', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  partnerId: bigint('partner_id', { mode: 'number' }).references(() => loyaltyPartners.id),
  name: text('name').notNull(),
  description: text('description'),
  kind: text('kind').notNull().default('discount_percent'), // discount_percent | discount_amount | freebie | access
  value: numeric('value', { precision: 14, scale: 2 }).default('0'),
  tierMin: integer('tier_min'),                           // min LIFETIME points to claim (null = any member) — same gating as rewards
  stock: integer('stock'),                                // null = unlimited
  perMemberLimit: integer('per_member_limit'),            // null = unlimited claims per member
  validFrom: text('valid_from'),                          // YYYY-MM-DD
  validTo: text('valid_to'),
  active: boolean('active').default(true),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ idxPartner: index('loyalty_privileges_partner').on(t.partnerId) }));

// A member's claim of a privilege — a single-use code the partner redeems.
export const loyaltyPrivilegeClaims = pgTable('loyalty_privilege_claims', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  privilegeId: bigint('privilege_id', { mode: 'number' }).references(() => loyaltyPrivileges.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  claimCode: text('claim_code').notNull(),                // PRV-…
  status: text('status').notNull().default('claimed'),    // claimed | used | void
  claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  usedAtPartner: text('used_at_partner'),
}, (t) => ({ uqCode: uniqueIndex('loyalty_privilege_claims_code').on(t.claimCode), idxMember: index('loyalty_privilege_claims_member').on(t.memberId) }));

export type LoyaltyPartner = typeof loyaltyPartners.$inferSelect;
export type LoyaltyPrivilege = typeof loyaltyPrivileges.$inferSelect;
export type LoyaltyPrivilegeClaim = typeof loyaltyPrivilegeClaims.$inferSelect;

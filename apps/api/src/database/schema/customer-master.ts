// Unified customer master / customer-of-record (REV-15). Links the two pre-existing customer silos —
// B2C loyalty (pos_members via member_id) and B2B accounts (a customer tenant via account_code) — into one
// registry so a 360° view and revenue-by-customer resolve to a single record. Tenant-scoped (RLS via 0149).
import { pgTable, bigserial, bigint, text, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { encryptedText } from '../encrypted-column';

export const customerMaster = pgTable('customer_master', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  customerNo: text('customer_no').notNull(),       // CUS-YYYYMMDD-NNN
  name: text('name').notNull(),
  kind: text('kind').notNull().default('person'),  // person | company
  // PII-at-rest (0284): encrypted; a companion `_bidx` (blindIndex()) column carries the exact-match lookup
  // key. Substring `ilike` search is no longer possible over phone/email — see docs/ops/pii-encryption-rollout.md.
  email: encryptedText('email'),
  emailBidx: text('email_bidx'),
  phone: encryptedText('phone'),
  phoneBidx: text('phone_bidx'),
  taxId: encryptedText('tax_id'),                  // PII-at-rest (panel #2): Thai tax/national ID — NOT queried → safe to encrypt transparently
  memberId: bigint('member_id', { mode: 'number' }), // → pos_members.id (B2C loyalty link)
  accountCode: text('account_code'),               // B2B customer tenant code (orders + AR)
  address: encryptedText('address'),               // buyer address for tax invoices — not searched → encrypted (0269)
  branchCode: text('branch_code'),                 // buyer's VAT branch, e.g. for the ม.86/4 buyer block (0269)
  status: text('status').notNull().default('active'), // active | inactive
  // Master-data audit Phase 3 (0271) — Oracle/NetSuite-grade fields: credit terms, sales-rep ownership,
  // segmentation category, preferred document language, and an external system reference for migrated data.
  creditTerms: text('credit_terms'),
  salesRep: text('sales_rep'),
  category: text('category'),
  language: text('language').default('th'),
  externalRef: text('external_ref'),
  // Party-model depth (0272, master-data audit Phase 4) — a subsidiary/branch account can point at its
  // parent's customer_no for consolidated credit/reporting; self-referencing by customer_no (the natural
  // key already used everywhere) rather than a numeric FK, since that's how every other lookup here works.
  parentCustomerNo: text('parent_customer_no'),
  notes: encryptedText('notes'),                   // free-text may hold PII — NOT queried → encrypted at rest
  // Match-merge / DQM (0273, master-data audit Phase 5) — when a duplicate is merged into a survivor it is
  // soft-retired (status='merged') with a pointer to the survivor's id + who/when, so the merge is fully
  // traceable and the record is never physically destroyed.
  mergedInto: bigint('merged_into', { mode: 'number' }),
  mergedBy: text('merged_by'),
  mergedAt: timestamp('merged_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  uqNo: unique('uq_customer_master_no').on(t.tenantId, t.customerNo),
  byName: index('idx_customer_master_name').on(t.tenantId, t.name),
  byMember: index('idx_customer_master_member').on(t.memberId),
  // 0284: exact-match search indexes for the encrypted phone/email columns.
  byPhoneBidx: index('idx_customer_master_phone_bidx').on(t.tenantId, t.phoneBidx),
  byEmailBidx: index('idx_customer_master_email_bidx').on(t.tenantId, t.emailBidx),
}));

export type CustomerMaster = typeof customerMaster.$inferSelect;

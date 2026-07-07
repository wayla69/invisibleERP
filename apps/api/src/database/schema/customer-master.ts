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
  email: text('email'),                            // searched via ilike → kept plaintext (blind-index rollout: see docs/ops/pii-encryption-rollout.md)
  phone: text('phone'),                            // searched via ilike → kept plaintext (see rollout doc)
  taxId: encryptedText('tax_id'),                  // PII-at-rest (panel #2): Thai tax/national ID — NOT queried → safe to encrypt transparently
  memberId: bigint('member_id', { mode: 'number' }), // → pos_members.id (B2C loyalty link)
  accountCode: text('account_code'),               // B2B customer tenant code (orders + AR)
  address: encryptedText('address'),               // buyer address for tax invoices — not searched → encrypted (0269)
  branchCode: text('branch_code'),                 // buyer's VAT branch, e.g. for the ม.86/4 buyer block (0269)
  status: text('status').notNull().default('active'), // active | inactive
  notes: encryptedText('notes'),                   // free-text may hold PII — NOT queried → encrypted at rest
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqNo: unique('uq_customer_master_no').on(t.tenantId, t.customerNo), byName: index('idx_customer_master_name').on(t.tenantId, t.name), byMember: index('idx_customer_master_member').on(t.memberId) }));

export type CustomerMaster = typeof customerMaster.$inferSelect;

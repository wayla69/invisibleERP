// Sensitive master-data bulk-import maker-checker (audit G5/G7/G8, migration 0263). A registry-driven
// import batch that touches a financially-sensitive field (customer/vendor credit limit R09, vendor payment
// terms R02, price-list prices / promotion discounts R10) is STAGED here as PendingApproval — the raw rows
// are held as JSON and nothing is written to the entity table until a DIFFERENT user approves it.
// Tenant-scoped (RLS via migration 0263).
import { pgTable, bigserial, bigint, integer, text, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const masterdataImportBatches = pgTable('masterdata_import_batches', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  reqNo: text('req_no').notNull(),          // MDI-YYYYMMDD-NNN
  entityKey: text('entity_key').notNull(),  // registry key (customers | vendors | price_list | promotions | …)
  mode: text('mode').notNull(),             // append | replace
  rows: text('rows').notNull(),             // JSON array of the header-keyed import rows (held until approval)
  rowCount: integer('row_count').notNull().default(0),
  sensitiveFields: text('sensitive_fields'),// comma-joined sensitive headers that triggered staging
  status: text('status').notNull().default('PendingApproval'), // PendingApproval | Approved | Rejected
  result: text('result'),                   // JSON import result recorded on approval
  requestedBy: text('requested_by'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
  approvedBy: text('approved_by'),           // checker — must differ from requester
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  rejectReason: text('reject_reason'),
});

export type MasterdataImportBatch = typeof masterdataImportBatches.$inferSelect;

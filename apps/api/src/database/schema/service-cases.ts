// SVC-4 — Service Cloud: Support Cases + Email-to-Case (net-new customer-service foundation; distinct from the
// #666 subscription/SLA service spine in ./service.ts and the SVC-2 warranty registry in ./service-warranty.ts).
// Two tenant-scoped tables:
//   • service_cases        — a support case (ticket) raised by/for a customer: a governed status lifecycle
//                            (new → open → pending → resolved → closed, reopen back to open), a priority
//                            (P1..P4), an owner/assignee, and an optional CRM contact/account link. A case
//                            carries a stable email thread_token so customer replies thread back onto it.
//   • case_email_messages  — the append-only email trail of a case: each inbound (customer→us) or outbound
//                            (us→customer) message, deduped per tenant on the provider Message-ID.
// Email-to-Case (SVC-04 control): a @Public @NoTx HMAC-authenticated webhook (mirrors crm/inbound) posts a
// parsed customer email to /api/service/email-to-case/inbound/<tenant code>; a reply carrying the case thread
// token threads onto the existing case, else the sender address matches an OPEN case by contact, else a NEW
// case is opened — so no inbound customer email is ever dropped. Append-only: never posts to the GL.
// Each table is RLS-scoped (canonical 0232-form tenant_isolation, migration 0350) with a leading (tenant_id,…)
// index. No GL post in v1 (a service-order / billable-time posting is future work).
import { pgTable, bigserial, bigint, text, timestamp, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// status: 'new' | 'open' | 'pending' | 'resolved' | 'closed'  (governed lifecycle)
// priority: 'P1' | 'P2' | 'P3' | 'P4'
// source: 'email' | 'manual' | 'phone'
export const serviceCases = pgTable('service_cases', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  caseNo: text('case_no').notNull(),
  subject: text('subject').notNull(),
  description: text('description'),
  status: text('status').notNull().default('new'),
  priority: text('priority').notNull().default('P3'),
  source: text('source').notNull().default('manual'),
  contactId: bigint('contact_id', { mode: 'number' }),
  contactEmail: text('contact_email'),
  accountId: bigint('account_id', { mode: 'number' }),
  customerName: text('customer_name'),
  assignee: text('assignee'),
  threadToken: text('thread_token'), // stable per-case email reply-threading token (svct_<hex>)
  // SVC-5 — SLA entitlement: due times computed from the tier at open/entitlement, breach flags stamped on
  // first response / resolution (a tier→hours policy, mirroring the #666 contract SLA tiers).
  slaTier: text('sla_tier').notNull().default('Standard'),
  firstResponseDueAt: timestamp('first_response_due_at', { withTimezone: true }),
  resolutionDueAt: timestamp('resolution_due_at', { withTimezone: true }),
  firstRespondedAt: timestamp('first_responded_at', { withTimezone: true }),
  responseBreached: boolean('response_breached').notNull().default(false),
  resolutionBreached: boolean('resolution_breached').notNull().default(false),
  openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  resolutionNote: text('resolution_note'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_service_cases_tenant').on(t.tenantId, t.status),
  uqNo: uniqueIndex('uq_service_cases_no').on(t.tenantId, t.caseNo),
  byToken: index('idx_service_cases_token').on(t.tenantId, t.threadToken),
  byContact: index('idx_service_cases_contact').on(t.tenantId, t.contactEmail),
}));

// direction: 'inbound' (customer → us) | 'outbound' (us → customer)
export const caseEmailMessages = pgTable('case_email_messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  caseId: bigint('case_id', { mode: 'number' }).references(() => serviceCases.id),
  direction: text('direction').notNull().default('inbound'),
  fromAddr: text('from_addr'),
  toAddr: text('to_addr'),
  subject: text('subject'),
  bodyPreview: text('body_preview'),
  messageId: text('message_id'), // provider Message-ID (dedupe key)
  threadToken: text('thread_token'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({
  byTenant: index('idx_case_email_messages_tenant').on(t.tenantId, t.caseId),
  uqMsg: uniqueIndex('uq_case_email_messages_msgid').on(t.tenantId, t.messageId),
}));

export type ServiceCase = typeof serviceCases.$inferSelect;
export type CaseEmailMessage = typeof caseEmailMessages.$inferSelect;

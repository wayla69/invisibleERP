import { bigint, bigserial, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Outbound transactional-email outbox (A1, migration 0452). Platform-level — deliberately NO tenant_id
// column (about_tenant_id instead) so the generic RLS loop + tenant-index guard skip it, mirroring
// platform_notifications. Every send is recorded here first (Queued), then delivered by the background
// job worker ('platform_email' job) or the god deliver-pending endpoint; Sent/Failed + provider evidence
// make the outbox the ITGC audit trail for customer-facing platform mail.
export const platformEmails = pgTable('platform_emails', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  template: text('template').notNull(), // signup_approved | signup_rejected | signup_invite | trial_reminder | payment_failed | company_suspended
  toEmail: text('to_email').notNull(),
  lang: text('lang').notNull().default('th'),
  subject: text('subject').notNull(),
  vars: jsonb('vars'), // template variables as given (rendered again at delivery; PII-light by convention)
  status: text('status').notNull().default('Queued'), // Queued | Sent | Failed
  provider: text('provider'), // mock | resend | postmark (stamped at delivery)
  providerMsgId: text('provider_msg_id'),
  error: text('error'),
  aboutTenantId: bigint('about_tenant_id', { mode: 'number' }), // which company it concerns (nullable)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
}, (t) => ({
  byCreated: index('platform_emails_created_idx').on(t.createdAt),
  byStatus: index('platform_emails_status_idx').on(t.status),
}));

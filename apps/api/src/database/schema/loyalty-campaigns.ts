// CRM Phase 4 — campaign orchestration. A named, segmented, optionally-scheduled broadcast over the existing
// messaging gateways + message_log. Sends respect PDPA marketing consent and are idempotent (a 'sent' campaign
// won't re-send). Per-recipient delivery is audited in message_log (campaign = the campaign_code). tenant_id
// REQUIRED → RLS.
import { pgTable, bigserial, bigint, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const loyaltyCampaigns = pgTable('loyalty_campaigns', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  campaignCode: text('campaign_code').notNull(),          // CMP-…
  name: text('name').notNull(),
  channel: text('channel').notNull().default('sms'),      // sms | email | line
  audience: text('audience').notNull().default('all'),    // all | segment | tier | birthdays_today
  segment: text('segment'),                               // RFM segment (audience=segment)
  tier: text('tier'),                                     // loyalty tier (audience=tier)
  body: text('body').notNull(),
  scheduleAt: timestamp('schedule_at', { withTimezone: true }), // null = manual send
  status: text('status').notNull().default('draft'),      // draft | scheduled | sent | cancelled
  targeted: integer('targeted').default(0),
  sentCount: integer('sent_count').default(0),
  skippedCount: integer('skipped_count').default(0),
  failedCount: integer('failed_count').default(0),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
});

export type LoyaltyCampaign = typeof loyaltyCampaigns.$inferSelect;

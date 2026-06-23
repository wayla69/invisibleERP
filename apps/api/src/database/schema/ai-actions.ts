import { pgTable, bigserial, bigint, text, jsonb, numeric, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Phase D1 — agentic write-ops queue. The AI proposes an action (PENDING); a DIFFERENT authorized
// human approves it (SoD), which executes through the normal service + GL. See 0063 migration.
export const aiActionRequests = pgTable('ai_action_requests', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  kind: text('kind').notNull(),                 // journal_entry | purchase_order
  payload: jsonb('payload').notNull(),
  rationale: text('rationale'),
  amount: numeric('amount', { precision: 18, scale: 2 }),
  status: text('status').notNull().default('pending'), // pending|approved|rejected|executed|failed
  proposedBy: text('proposed_by').notNull(),
  source: text('source').default('ai'),         // ai | human
  createdAt: timestamp('created_at').defaultNow(),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at'),
  decisionReason: text('decision_reason'),
  resultRef: text('result_ref'),
  errorMessage: text('error_message'),
});

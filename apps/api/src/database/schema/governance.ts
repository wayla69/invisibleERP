import { pgTable, bigserial, bigint, text, timestamp, boolean, unique } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Entity-level governance evidence capture (W3 — closes the SYSTEM side of ELC-01 / ELC-04; the policy +
// governance bodies themselves remain an org/PMO process, so these controls move Gap → Partial).

// ELC-01 — code-of-conduct / ethics annual acknowledgement register. One row per (tenant, user, version);
// the UNIQUE makes re-acknowledging the same policy version idempotent. The sample-able evidence that staff
// acknowledged the code of conduct.
export const ethicsAcknowledgements = pgTable('ethics_acknowledgements', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  username: text('username').notNull(),
  policyVersion: text('policy_version').notNull(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uq: unique('ethics_ack_tenant_user_version_uq').on(t.tenantId, t.username, t.policyVersion) }));

// ELC-04 — whistleblower / ethics hotline intake + case log. Anonymous-capable (reporter recorded only when
// the submitter opts out of anonymity). Status lifecycle received → investigating → resolved | dismissed,
// handled by the audit committee / compliance. The reviewable case log + resolution evidence.
export const whistleblowerCases = pgTable('whistleblower_cases', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  caseRef: text('case_ref').notNull().unique(),
  category: text('category'),
  allegation: text('allegation').notNull(),
  reporter: text('reporter'), // null when filed anonymously (non-retaliation)
  anonymous: boolean('anonymous').notNull().default(true),
  status: text('status').notNull().default('received'), // received | investigating | resolved | dismissed
  resolutionNote: text('resolution_note'),
  handledBy: text('handled_by'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

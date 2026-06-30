import { pgTable, bigserial, bigint, text, timestamp, boolean, numeric, date, unique } from 'drizzle-orm/pg-core';
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

// ELC-03 — Delegation-of-Authority matrix: which role may authorize what, up to what limit. Documents the
// approval matrix the RCM references (maps to permissions.ts + the maker-checker limits). Evidence that
// authority is defined and bounded; the human DoA policy/sign-off remains an org process.
export const delegationOfAuthority = pgTable('delegation_of_authority', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  authorityArea: text('authority_area').notNull(), // e.g. 'AP payment', 'Journal entry', 'PO approval'
  role: text('role').notNull(),                    // role/title that holds the authority
  approvalLimit: numeric('approval_limit', { precision: 16, scale: 2 }), // null = unlimited
  currency: text('currency').notNull().default('THB'),
  notes: text('notes'),
  effectiveFrom: date('effective_from'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uq: unique('doa_tenant_area_role_uq').on(t.tenantId, t.authorityArea, t.role) }));

// ELC-05 — Fraud-risk register: identified fraud risks, likelihood/impact, mitigating controls, owner, and
// review status. The sample-able fraud-risk-assessment artifact; the assessment itself is an org process.
export const fraudRisks = pgTable('fraud_risks', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  riskRef: text('risk_ref').notNull().unique(),
  area: text('area').notNull(),                    // e.g. 'Revenue', 'Cash', 'JE override', 'Related parties'
  description: text('description').notNull(),
  likelihood: text('likelihood').notNull().default('medium'), // low | medium | high
  impact: text('impact').notNull().default('medium'),         // low | medium | high
  mitigatingControls: text('mitigating_controls'), // references the RCM control IDs / process that mitigate it
  owner: text('owner'),
  status: text('status').notNull().default('open'), // open | mitigated | accepted | closed
  lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true }),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ELC-02 — Audit-committee / governance oversight log: oversight meetings + the quarterly ICFR review &
// sign-off. The minutes/oversight evidence an auditor samples; holding the meetings is an org process.
export const governanceOversight = pgTable('governance_oversight', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  meetingDate: date('meeting_date').notNull(),
  kind: text('kind').notNull().default('audit_committee'),
  topics: text('topics'),
  icfrReviewed: boolean('icfr_reviewed').notNull().default(false),
  findingsReviewed: text('findings_reviewed'),
  attendees: text('attendees'),
  minutesRef: text('minutes_ref'),
  signedOffBy: text('signed_off_by'),
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

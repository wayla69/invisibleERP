// Phase G1 (docs/25) — lifecycle journeys: a marketer-designed, multi-step drip a member moves through
// ("enrol → wait 3 days → message → wait 7 → escalate"). Steps are LINEAR v1: each step = wait N days, then
// send (channel/body) unless a skip-rule (single F1-whitelisted field/op/value rule) matches the member.
// Sends go through MessagingService (consent-respecting) and are frequency-capped per member. The runner
// claims each enrollment-step with an atomic guarded UPDATE (claim-first, at-most-once — control MKT-12).
// tenant_id REQUIRED on all three tables → RLS.
import { pgTable, bigserial, bigint, text, integer, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { posMembers } from './loyalty-members';
import { savedSegments } from './crm';

export const journeys = pgTable('journeys', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  code: text('code').notNull(),                             // JNY-…
  name: text('name').notNull(),
  status: text('status').notNull().default('draft'),       // draft | active | paused
  // Entry: 'manual' (staff/API/automation `enroll_journey` action) or 'segment' (the runner sweeps the
  // saved segment and enrols members who match — once each, the enrollment unique key dedupes re-entry).
  trigger: text('trigger').notNull().default('manual'),    // manual | segment
  segmentId: bigint('segment_id', { mode: 'number' }).references(() => savedSegments.id), // trigger=segment
  // Frequency cap: at most cap_messages journey messages per member per cap_window_days (0 = uncapped).
  capMessages: integer('cap_messages').notNull().default(0),
  capWindowDays: integer('cap_window_days').notNull().default(7),
  defaultSendHour: integer('default_send_hour').notNull().default(10), // H3: snap hour (Asia/Bangkok) when the member has no preferred_hour
  createdBy: text('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => ({ uqCode: uniqueIndex('journeys_tenant_code').on(t.tenantId, t.code) }));

export const journeySteps = pgTable('journey_steps', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  journeyId: bigint('journey_id', { mode: 'number' }).references(() => journeys.id),
  stepNo: integer('step_no').notNull(),                     // 1-based, linear
  waitDays: integer('wait_days').notNull().default(0),      // wait before this step's send
  channel: text('channel').notNull().default('sms'),        // sms | email | line
  body: text('body').notNull(),
  skipRule: jsonb('skip_rule'),                             // { field, op, value } — F1 whitelist; null = always send
  // H1 (docs/26) — rule-based FORWARD-ONLY jump: after this step executes, if branch_rule matches the member
  // the enrollment advances to branch_to_step instead of step_no+1. branch_to_step > step_no is enforced at
  // create, so termination is structural (no loop detection needed).
  branchRule: jsonb('branch_rule'),                         // { field, op, value } — same F1 whitelist
  branchToStep: integer('branch_to_step'),                  // forward jump target (> step_no)
}, (t) => ({ uqStep: uniqueIndex('journey_steps_journey_step').on(t.journeyId, t.stepNo) }));

export const journeyEnrollments = pgTable('journey_enrollments', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  journeyId: bigint('journey_id', { mode: 'number' }).references(() => journeys.id),
  memberId: bigint('member_id', { mode: 'number' }).references(() => posMembers.id),
  currentStep: integer('current_step').notNull().default(1),
  status: text('status').notNull().default('active'),      // active | completed | exited
  nextRunAt: timestamp('next_run_at', { withTimezone: true }), // due when <= now; NULL while a step is claimed
  enrolledAt: timestamp('enrolled_at', { withTimezone: true }).defaultNow(),
  lastStepAt: timestamp('last_step_at', { withTimezone: true }),
}, (t) => ({
  // once-per-member re-entry policy (v1): a member can only ever be enrolled once per journey.
  uqMember: uniqueIndex('journey_enrollments_journey_member').on(t.journeyId, t.memberId),
  idxDue: index('journey_enrollments_due').on(t.tenantId, t.status, t.nextRunAt),
}));

export type Journey = typeof journeys.$inferSelect;
export type JourneyStep = typeof journeySteps.$inferSelect;
export type JourneyEnrollment = typeof journeyEnrollments.$inferSelect;

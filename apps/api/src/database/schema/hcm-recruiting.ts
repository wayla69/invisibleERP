import { pgTable, bigserial, bigint, integer, text, numeric, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';
import { hrPositions } from './hcm-org';

// ── HR-4 (docs/42 HCM depth, Wave 2) — Recruiting / ATS ──────────────────────────────────────────────
// Requisition → candidate pipeline → offer → hire, all on the payroll.employees identity (a hire creates a
// payroll.employees row from an accepted+approved offer). Four tenant-scoped tables (RLS + a leading
// (tenant_id, …) index). The HR-04 control lives in hcm-recruiting.service.ts:
//   1. a job_requisition must be `approved` by a DIFFERENT user than requested_by (SOD_SELF_APPROVAL) before
//      any of its applications may advance to the offer/hired stages (REQUISITION_NOT_APPROVED);
//   2. an offer must be approved by hr_admin/exec (≠ the offer creator) before it can convert (OFFER_NOT_APPROVED);
//   3. hiring beyond the requisition headcount → HEADCOUNT_EXCEEDED (mirrors the HR-01 establishment control).

// Job requisitions — an approved request to fill N seats of a position. req_no is unique per tenant. The
// approval is maker-checker (approved_by ≠ requested_by); a requisition gates its pipeline's offer/hire stages.
export const jobRequisitions = pgTable(
  'job_requisitions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    reqNo: text('req_no').notNull(),
    positionId: bigint('position_id', { mode: 'number' }).references(() => hrPositions.id), // links the establishment (nullable)
    deptId: bigint('dept_id', { mode: 'number' }),                                           // free hint (hr_departments.id)
    headcount: integer('headcount').notNull().default(1),
    status: text('status').notNull().default('draft'), // draft|pending|approved|rejected|filled|closed
    justification: text('justification'),
    requestedBy: text('requested_by'),
    approvedBy: text('approved_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uqReq: uniqueIndex('uq_job_req_no').on(t.tenantId, t.reqNo),
    byStatus: index('idx_job_req_status').on(t.tenantId, t.status),
  }),
);

// Candidates — a person in the talent pool (cand_no unique per tenant). Kept separate from employees so an
// applicant only becomes a payroll.employees row on hire (offer convert).
export const candidates = pgTable(
  'candidates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    candNo: text('cand_no').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    phone: text('phone'),
    source: text('source'),        // referral/agency/jobboard/…
    resumeUrl: text('resume_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uqCand: uniqueIndex('uq_candidate_no').on(t.tenantId, t.candNo),
    byEmail: index('idx_candidate_email').on(t.tenantId, t.email),
  }),
);

// Applications — a candidate's journey through one requisition's pipeline. stage advances
// applied→screen→interview→offer→hired (or →rejected). The offer/hired stages require an approved requisition.
export const applications = pgTable(
  'applications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    requisitionId: bigint('requisition_id', { mode: 'number' }).notNull().references(() => jobRequisitions.id),
    candidateId: bigint('candidate_id', { mode: 'number' }).notNull().references(() => candidates.id),
    stage: text('stage').notNull().default('applied'), // applied|screen|interview|offer|hired|rejected
    rating: numeric('rating', { precision: 4, scale: 2 }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    byReq: index('idx_application_req').on(t.tenantId, t.requisitionId),
    byCand: index('idx_application_cand').on(t.tenantId, t.candidateId),
  }),
);

// Offers — a proposed hire against an application. status is maker-checker (approved_by ≠ creator) then
// accepted/declined/withdrawn. Only an accepted + approved offer may convert into a payroll.employees row.
export const offers = pgTable(
  'offers',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    applicationId: bigint('application_id', { mode: 'number' }).notNull().references(() => applications.id),
    offeredSalary: numeric('offered_salary', { precision: 14, scale: 2 }).notNull().default('0'),
    offeredGrade: text('offered_grade'),
    startDate: date('start_date'),
    status: text('status').notNull().default('pending'), // pending|approved|accepted|declined|withdrawn
    createdBy: text('created_by'),
    approvedBy: text('approved_by'),
    hiredEmpCode: text('hired_emp_code'), // set on convert → the payroll.employees.emp_code created
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    byApp: index('idx_offer_application').on(t.tenantId, t.applicationId),
    byStatus: index('idx_offer_status').on(t.tenantId, t.status),
  }),
);

export type JobRequisition = typeof jobRequisitions.$inferSelect;
export type Candidate = typeof candidates.$inferSelect;
export type Application = typeof applications.$inferSelect;
export type Offer = typeof offers.$inferSelect;

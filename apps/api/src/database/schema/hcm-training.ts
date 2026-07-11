import { pgTable, bigserial, bigint, text, numeric, boolean, integer, date, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── HR-7 (docs/42 HCM depth, Wave 3) — Training & Certifications ──────────────────────────────────────────
// Extends the HCM module on the payroll.employees identity (emp_code). All four tables are tenant-scoped (RLS +
// a leading (tenant_id, …) index). The HR-07 training-compliance control lives in hcm-training.service.ts:
// completing an enrollment for a course with `validity_months` set MINTS/renews a certifications row whose
// expiry_date = completed_date + validity_months (the recurring-training / recert cadence), and the detective
// read GET /api/hcm/training/compliance?days=N returns employees whose MANDATORY-course certifications are
// expired or expiring within N days — the periodic compliance evidence. A guard blocks a `completed` transition
// with no score when the course requires one (SCORE_REQUIRED).

// Training courses — the per-tenant course catalogue. course_code is unique per tenant. is_mandatory marks a
// course whose certification lapse is a compliance finding; validity_months drives the recert cadence (a NULL /
// 0 validity_months mints a non-expiring certification).
export const trainingCourses = pgTable(
  'training_courses',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    courseCode: text('course_code').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull().default('general'),   // 'safety' | 'compliance' | 'technical' | 'general'
    isMandatory: boolean('is_mandatory').notNull().default(false),
    requiresScore: boolean('requires_score').notNull().default(false), // completing requires a score (SCORE_REQUIRED)
    passScore: numeric('pass_score', { precision: 6, scale: 2 }),       // optional pass threshold
    validityMonths: integer('validity_months'),                // recert cadence; NULL/0 → non-expiring cert
    active: boolean('active').default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uqCourse: uniqueIndex('uq_training_course_code').on(t.tenantId, t.courseCode),
  }),
);

// Training sessions — scheduled deliveries of a course. status scheduled → completed | cancelled.
export const trainingSessions = pgTable(
  'training_sessions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    courseId: bigint('course_id', { mode: 'number' }).notNull().references(() => trainingCourses.id),
    sessionDate: date('session_date').notNull(),
    instructor: text('instructor'),
    location: text('location'),
    capacity: integer('capacity'),
    status: text('status').notNull().default('scheduled'),   // 'scheduled' | 'completed' | 'cancelled'
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    byCourse: index('idx_training_session_course').on(t.tenantId, t.courseId),
    byStatus: index('idx_training_session_status').on(t.tenantId, t.status),
  }),
);

// Training enrollments — employee → session. status enrolled → attended → completed | failed. Completing a
// certification-bearing course (validity_months set on the course) MINTS a certifications row (HR-07).
export const trainingEnrollments = pgTable(
  'training_enrollments',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    sessionId: bigint('session_id', { mode: 'number' }).notNull().references(() => trainingSessions.id),
    empCode: text('emp_code').notNull(),
    status: text('status').notNull().default('enrolled'),   // 'enrolled' | 'attended' | 'completed' | 'failed'
    score: numeric('score', { precision: 6, scale: 2 }),
    completedDate: date('completed_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    byEmp: index('idx_training_enroll_emp').on(t.tenantId, t.empCode),
    bySession: index('idx_training_enroll_session').on(t.tenantId, t.sessionId),
  }),
);

// Certifications — an employee credential minted on course completion (source_course_id set) or recorded
// directly. expiry_date NULL = non-expiring. status active → expired (derived at read time from expiry_date).
export const certifications = pgTable(
  'certifications',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    empCode: text('emp_code').notNull(),
    certCode: text('cert_code').notNull(),
    name: text('name').notNull(),
    sourceCourseId: bigint('source_course_id', { mode: 'number' }).references(() => trainingCourses.id),
    isMandatory: boolean('is_mandatory').notNull().default(false), // copied from the source course at mint time
    issuedDate: date('issued_date').notNull(),
    expiryDate: date('expiry_date'),                        // nullable → non-expiring
    status: text('status').notNull().default('active'),   // 'active' | 'expired' | 'superseded'
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    byEmp: index('idx_certification_emp').on(t.tenantId, t.empCode),
    byExpiry: index('idx_certification_expiry').on(t.tenantId, t.expiryDate),
  }),
);

export type TrainingCourse = typeof trainingCourses.$inferSelect;
export type TrainingSession = typeof trainingSessions.$inferSelect;
export type TrainingEnrollment = typeof trainingEnrollments.$inferSelect;
export type Certification = typeof certifications.$inferSelect;

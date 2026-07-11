import { pgTable, bigserial, bigint, text, numeric, date, timestamp, index } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// ── HR-3 Performance management (docs/42 HCM depth) — appraisal cycles, goals (OKR-style) and the
//    self→manager→calibration→sign-off review workflow. Control HR-03 (review sign-off SoD): the manager
//    rating + sign-off must be performed by someone OTHER than the employee under review, and a review may
//    only be signed once it carries a manager rating. Goal weights per employee/cycle validate ≤ 100%.
//    All three tables are tenant-scoped (RLS via the canonical 0232-form tenant_isolation loop; leading
//    (tenant_id,…) index). Employee link is by empCode (payroll.employees) — no FK (soft ref, mirrors hcm).

// Appraisal cycle (e.g. "H1-2026"): open → calibration → closed.
export const perfCycles = pgTable(
  'perf_cycles',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    name: text('name').notNull(),
    periodStart: date('period_start'),
    periodEnd: date('period_end'),
    status: text('status').notNull().default('open'), // open | calibration | closed
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_perf_cycles_tenant').on(t.tenantId, t.id) }),
);

// A goal/objective for one employee within a cycle. weight_pct contributes to the ≤100% validation.
export const perfGoals = pgTable(
  'perf_goals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    cycleId: bigint('cycle_id', { mode: 'number' }).notNull(),
    empCode: text('emp_code').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    weightPct: numeric('weight_pct', { precision: 6, scale: 2 }).default('0'),
    metric: text('metric'),
    target: text('target'),
    status: text('status').notNull().default('draft'), // draft | active | achieved | missed
    progressPct: numeric('progress_pct', { precision: 6, scale: 2 }).default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_perf_goals_tenant').on(t.tenantId, t.cycleId), byEmp: index('idx_perf_goals_emp').on(t.empCode) }),
);

// The appraisal review record — self assessment, manager rating, calibrated rating, sign-off (HR-03 SoD).
export const perfReviews = pgTable(
  'perf_reviews',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
    cycleId: bigint('cycle_id', { mode: 'number' }).notNull(),
    empCode: text('emp_code').notNull(),
    selfRating: numeric('self_rating', { precision: 4, scale: 2 }),
    managerRating: numeric('manager_rating', { precision: 4, scale: 2 }),
    managerEmpCode: text('manager_emp_code'),
    calibratedRating: numeric('calibrated_rating', { precision: 4, scale: 2 }),
    comments: text('comments'),
    status: text('status').notNull().default('self'), // self | manager | calibrated | signed
    signedBy: text('signed_by'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (t) => ({ byTenant: index('idx_perf_reviews_tenant').on(t.tenantId, t.cycleId), byEmp: index('idx_perf_reviews_emp').on(t.empCode) }),
);

export type PerfCycle = typeof perfCycles.$inferSelect;
export type PerfGoal = typeof perfGoals.$inferSelect;
export type PerfReview = typeof perfReviews.$inferSelect;

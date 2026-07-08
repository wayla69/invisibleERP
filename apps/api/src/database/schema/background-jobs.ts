import { pgTable, bigserial, bigint, text, jsonb, integer, boolean, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

// Async job queue (migration 0179). Tenant-scoped, at-least-once. A request enqueues and returns 202;
// the in-process worker claims due 'queued' rows (FOR UPDATE SKIP LOCKED) and runs the handler in the
// job's own tenant transaction. RLS-isolated like every other tenant table.
export const backgroundJobs = pgTable('background_jobs', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  tenantId: bigint('tenant_id', { mode: 'number' }).references(() => tenants.id),
  jobType: text('job_type').notNull(),
  payload: jsonb('payload').notNull().default({}),
  status: text('status').notNull().default('queued'), // queued | running | done | failed
  actor: text('actor'),
  bypassRls: boolean('bypass_rls').notNull().default(false),
  result: jsonb('result'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type BackgroundJob = typeof backgroundJobs.$inferSelect;

// Scheduler heartbeats (0286 — docs/27 R1-5 / AUD-ARC-07): one row per scheduler name ('bi_scheduler'),
// stamped on every due-sweep (external cron, manual, or the optional in-process tick) so a scheduler that
// was working and silently died is detectable (the worker's reap cycle alerts on a stale row).
// PLATFORM-level BY DESIGN: no tenant_id column, so the tenant-idx gate and the RLS loop skip it.
export const schedulerHeartbeats = pgTable('scheduler_heartbeats', {
  name: text('name').primaryKey(),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }).notNull().defaultNow(),
  source: text('source'),
  detail: jsonb('detail'),
});

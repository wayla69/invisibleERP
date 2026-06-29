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

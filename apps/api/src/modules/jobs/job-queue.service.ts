import { rowsOf } from '../../common/db-rows';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { backgroundJobs } from '../../database/schema';
import { runInTenantContext } from '../../common/tenant-run';
import { captureOpsAlert } from '../../observability/instrumentation';
import type { JwtUser } from '../../common/decorators';

// A job stuck in 'running' longer than this (its worker died mid-handler, so markDone/markFailed never
// ran) is reaped — requeued if it has retries left, else dead-lettered. Env-tunable (default 5 min).
const STUCK_MS = () => Number(process.env.JOBS_STUCK_MS ?? 300_000);

export interface EnqueueArgs {
  jobType: string;
  payload?: Record<string, unknown>;
  tenantId: number | null; // the tenant the job runs for
  actor?: string | null;
  bypass?: boolean; // run the handler with HQ/admin RLS bypass
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: number;
  tenantId: number | null;
  jobType: string;
  payload: any;
  actor: string | null;
  bypass: boolean;
  attempts: number;
  maxAttempts: number;
}

// The persistent work queue. Enqueue/read run on the caller's tenant-scoped DRIZZLE (RLS isolates each
// tenant's jobs); claim/complete run in a bypass context (the worker spans tenants). At-least-once: a job
// is marked 'running' under a row lock before its handler runs, and retried with backoff on failure.
@Injectable()
export class JobQueueService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Enqueue from within a request (the caller's tenant tx). Returns the new job id.
  async enqueue(args: EnqueueArgs): Promise<number> {
    const db = this.db;
    const [row] = await db.insert(backgroundJobs).values({
      tenantId: args.tenantId,
      jobType: args.jobType,
      payload: args.payload ?? {},
      actor: args.actor ?? null,
      bypassRls: !!args.bypass,
      maxAttempts: args.maxAttempts ?? 3,
    }).returning({ id: backgroundJobs.id });
    return Number(row!.id);
  }

  // Claim the next due job across all tenants (worker path). One row at a time under FOR UPDATE SKIP LOCKED
  // so concurrent workers never grab the same job; the claim flips status→running and commits before the
  // handler runs (the row lock is NOT held for the handler's duration). Runs with RLS bypass.
  async claimNext(): Promise<ClaimedJob | null> {
    return runInTenantContext(this.db, { tenantId: null, bypass: true, actor: 'system:worker' }, async () => {
      const tx = this.db;
      const picked = await tx.execute(sql`
        SELECT id FROM background_jobs
        WHERE status = 'queued' AND run_after <= now()
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`);
      const first = rowsOf<{ id: number | string }>(picked)[0];
      if (!first) return null;
      const id = Number(first.id);
      const [job] = await tx.update(backgroundJobs)
        .set({ status: 'running', attempts: sql`${backgroundJobs.attempts} + 1`, lockedAt: new Date(), updatedAt: new Date() })
        .where(eq(backgroundJobs.id, id))
        .returning();
      return {
        id: Number(job!.id), tenantId: job!.tenantId != null ? Number(job!.tenantId) : null,
        jobType: job!.jobType, payload: job!.payload, actor: job!.actor, bypass: !!job!.bypassRls,
        attempts: Number(job!.attempts), maxAttempts: Number(job!.maxAttempts),
      };
    });
  }

  async markDone(id: number, result: unknown): Promise<void> {
    await runInTenantContext(this.db, { tenantId: null, bypass: true, actor: 'system:worker' }, async () => {
      await this.db.update(backgroundJobs)
        .set({ status: 'done', result: (result ?? {}) as any, error: null, lockedAt: null, updatedAt: new Date() })
        .where(eq(backgroundJobs.id, id));
    });
  }

  // Failed: retry with exponential backoff until max_attempts, then mark 'failed' (dead-letter).
  async markFailed(job: ClaimedJob, err: string): Promise<void> {
    const exhausted = job.attempts >= job.maxAttempts;
    const backoffSec = Math.min(300, 2 ** job.attempts); // 2,4,8,… capped at 5 min
    await runInTenantContext(this.db, { tenantId: null, bypass: true, actor: 'system:worker' }, async () => {
      await this.db.update(backgroundJobs)
        .set(exhausted
          ? { status: 'failed', error: err.slice(0, 2000), lockedAt: null, updatedAt: new Date() }
          : { status: 'queued', error: err.slice(0, 2000), lockedAt: null, runAfter: new Date(Date.now() + backoffSec * 1000), updatedAt: new Date() })
        .where(eq(backgroundJobs.id, job.id));
    });
    // ITGC-OP-04 — a job that exhausts its retries is a dead-letter: it will NEVER run again unless an
    // operator intervenes. Raise an operational alert so a silent dead-letter can't accumulate unnoticed.
    if (exhausted) captureOpsAlert('job_dead_letter', { jobId: job.id, jobType: job.jobType, tenantId: job.tenantId, attempts: job.attempts }, err);
  }

  // ITGC-OP-04 — reap jobs stuck in 'running' (their worker crashed mid-handler, so the row was never
  // resolved; the claim path only picks 'queued', so these would sit forever). Requeue if retries remain,
  // else dead-letter. Returns counts. Bypass context (cross-tenant). Idempotent / safe to run repeatedly.
  async reapStuck(staleMs: number = STUCK_MS()): Promise<{ requeued: number; deadLettered: number }> {
    return runInTenantContext(this.db, { tenantId: null, bypass: true, actor: 'system:reaper' }, async () => {
      const tx = this.db;
      // Typed builder (NOT a raw sql Date template — that crashes postgres-js in prod) for the cutoff.
      const cutoff = new Date(Date.now() - staleMs);
      const stale = await tx.select().from(backgroundJobs)
        .where(and(eq(backgroundJobs.status, 'running'), lt(backgroundJobs.lockedAt, cutoff)));
      let requeued = 0, deadLettered = 0;
      for (const j of stale) {
        const attempts = Number(j.attempts), maxAttempts = Number(j.maxAttempts);
        const tenantId = j.tenantId != null ? Number(j.tenantId) : null;
        if (attempts < maxAttempts) {
          await tx.update(backgroundJobs)
            .set({ status: 'queued', lockedAt: null, error: 'reaped: worker died mid-job (stale lock) — requeued', runAfter: new Date(), updatedAt: new Date() })
            .where(eq(backgroundJobs.id, j.id));
          requeued++;
        } else {
          await tx.update(backgroundJobs)
            .set({ status: 'failed', lockedAt: null, error: 'reaped: stuck running, retries exhausted', updatedAt: new Date() })
            .where(eq(backgroundJobs.id, j.id));
          deadLettered++;
          captureOpsAlert('job_stuck_dead_letter', { jobId: Number(j.id), jobType: j.jobType, tenantId, attempts });
        }
      }
      if (requeued || deadLettered) captureOpsAlert('jobs_reaped', { requeued, deadLettered, staleMs });
      return { requeued, deadLettered };
    });
  }

  // Cross-tenant operational counts for the metrics/health surface (ITGC-OP-04). Bypass context.
  async opsCounts(): Promise<{ queued: number; running: number; failed: number; stuck: number }> {
    return runInTenantContext(this.db, { tenantId: null, bypass: true, actor: 'system:metrics' }, async () => {
      const cutoffIso = new Date(Date.now() - STUCK_MS()).toISOString(); // string param — never a raw Date
      const res: any = await this.db.execute(sql`SELECT
        count(*) FILTER (WHERE status = 'queued')  AS queued,
        count(*) FILTER (WHERE status = 'running') AS running,
        count(*) FILTER (WHERE status = 'failed')  AS failed,
        count(*) FILTER (WHERE status = 'running' AND locked_at < ${cutoffIso}) AS stuck
        FROM background_jobs`);
      const r = rowsOf(res)[0] ?? {};
      return { queued: Number(r.queued ?? 0), running: Number(r.running ?? 0), failed: Number(r.failed ?? 0), stuck: Number(r.stuck ?? 0) };
    });
  }

  // Status read for the API — runs in the request's tenant tx, so RLS returns only the caller's jobs.
  async getJob(id: number, _user: JwtUser) {
    const db = this.db;
    const [j] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.id, id)).limit(1);
    if (!j) return null;
    return this.view(j);
  }

  async listJobs(jobType: string | undefined, _user: JwtUser) {
    const db = this.db;
    const where = jobType ? eq(backgroundJobs.jobType, jobType) : undefined;
    const rows = await db.select().from(backgroundJobs).where(where).orderBy(desc(backgroundJobs.id)).limit(100);
    return { jobs: rows.map((r: any) => this.view(r)), count: rows.length };
  }

  private view(j: any) {
    return {
      id: Number(j.id), job_type: j.jobType, status: j.status, attempts: Number(j.attempts),
      result: j.result ?? null, error: j.error ?? null,
      created_at: j.createdAt, updated_at: j.updatedAt,
    };
  }
}

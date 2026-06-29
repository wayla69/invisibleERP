import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { backgroundJobs } from '../../database/schema';
import { runInTenantContext } from '../../common/tenant-run';
import type { JwtUser } from '../../common/decorators';

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
    const db = this.db as any;
    const [row] = await db.insert(backgroundJobs).values({
      tenantId: args.tenantId,
      jobType: args.jobType,
      payload: args.payload ?? {},
      actor: args.actor ?? null,
      bypassRls: !!args.bypass,
      maxAttempts: args.maxAttempts ?? 3,
    }).returning({ id: backgroundJobs.id });
    return Number(row.id);
  }

  // Claim the next due job across all tenants (worker path). One row at a time under FOR UPDATE SKIP LOCKED
  // so concurrent workers never grab the same job; the claim flips status→running and commits before the
  // handler runs (the row lock is NOT held for the handler's duration). Runs with RLS bypass.
  async claimNext(): Promise<ClaimedJob | null> {
    return runInTenantContext(this.db, { tenantId: null, bypass: true, actor: 'system:worker' }, async () => {
      const tx = (this.db as any);
      const picked = await tx.execute(sql`
        SELECT id FROM background_jobs
        WHERE status = 'queued' AND run_after <= now()
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1`);
      const rows = (picked as any).rows ?? picked;
      const first = Array.isArray(rows) ? rows[0] : undefined;
      if (!first) return null;
      const id = Number(first.id);
      const [job] = await tx.update(backgroundJobs)
        .set({ status: 'running', attempts: sql`${backgroundJobs.attempts} + 1`, lockedAt: new Date(), updatedAt: new Date() })
        .where(eq(backgroundJobs.id, id))
        .returning();
      return {
        id: Number(job.id), tenantId: job.tenantId != null ? Number(job.tenantId) : null,
        jobType: job.jobType, payload: job.payload, actor: job.actor, bypass: !!job.bypassRls,
        attempts: Number(job.attempts), maxAttempts: Number(job.maxAttempts),
      };
    });
  }

  async markDone(id: number, result: unknown): Promise<void> {
    await runInTenantContext(this.db, { tenantId: null, bypass: true, actor: 'system:worker' }, async () => {
      await (this.db as any).update(backgroundJobs)
        .set({ status: 'done', result: (result ?? {}) as any, error: null, lockedAt: null, updatedAt: new Date() })
        .where(eq(backgroundJobs.id, id));
    });
  }

  // Failed: retry with exponential backoff until max_attempts, then mark 'failed' (dead-letter).
  async markFailed(job: ClaimedJob, err: string): Promise<void> {
    const exhausted = job.attempts >= job.maxAttempts;
    const backoffSec = Math.min(300, 2 ** job.attempts); // 2,4,8,… capped at 5 min
    await runInTenantContext(this.db, { tenantId: null, bypass: true, actor: 'system:worker' }, async () => {
      await (this.db as any).update(backgroundJobs)
        .set(exhausted
          ? { status: 'failed', error: err.slice(0, 2000), lockedAt: null, updatedAt: new Date() }
          : { status: 'queued', error: err.slice(0, 2000), lockedAt: null, runAfter: new Date(Date.now() + backoffSec * 1000), updatedAt: new Date() })
        .where(eq(backgroundJobs.id, job.id));
    });
  }

  // Status read for the API — runs in the request's tenant tx, so RLS returns only the caller's jobs.
  async getJob(id: number, _user: JwtUser) {
    const db = this.db as any;
    const [j] = await db.select().from(backgroundJobs).where(eq(backgroundJobs.id, id)).limit(1);
    if (!j) return null;
    return this.view(j);
  }

  async listJobs(jobType: string | undefined, _user: JwtUser) {
    const db = this.db as any;
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

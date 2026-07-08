import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { runInTenantContext } from '../../common/tenant-run';
import { JobQueueService, type ClaimedJob } from './job-queue.service';
import { SchedulerHeartbeatService } from './scheduler-heartbeat.service';

export interface JobContext { tenantId: number | null; actor: string | null; bypass: boolean; attempt: number }
export type JobHandler = (payload: any, ctx: JobContext) => Promise<unknown>;

// In-process job worker. Modules register a handler for their job type (in OnModuleInit); the worker polls
// the queue and runs each claimed job inside the job's own tenant transaction. The poll loop is OFF under
// tests (NODE_ENV=test) and when JOBS_WORKER_DISABLED=1 so harnesses drive it deterministically via tick();
// in prod it starts on application bootstrap and stops cleanly on shutdown.
@Injectable()
export class JobWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('JobWorker');
  private readonly handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private readonly pollMs = Number(process.env.JOBS_POLL_MS ?? 2000);
  // ITGC-OP-04 — how often (ms) to reap zombie 'running' jobs left by a crashed worker. Piggybacked on
  // the poll loop rather than a separate scheduler (the project has no @nestjs/schedule).
  private readonly reapMs = Number(process.env.JOBS_REAP_EVERY_MS ?? 60_000);
  private lastReapAt = 0;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly queue: JobQueueService,
    // Optional so a partially-constructed harness worker still builds (docs/27 R1-5 heartbeat check).
    @Optional() private readonly heartbeat?: SchedulerHeartbeatService,
  ) {}

  register(jobType: string, handler: JobHandler): void {
    if (this.handlers.has(jobType)) this.log.warn(`handler for '${jobType}' re-registered`);
    this.handlers.set(jobType, handler);
  }

  onApplicationBootstrap(): void {
    const disabled = process.env.NODE_ENV === 'test' || process.env.JOBS_WORKER_DISABLED === '1';
    if (disabled) { this.log.log('poll loop disabled (test/JOBS_WORKER_DISABLED) — drive via tick()'); return; }
    this.schedule();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.drain().finally(() => this.maybeReap().finally(() => this.schedule())); }, this.pollMs);
  }

  // Reap stuck jobs on an interval (throttled across poll cycles). Public + harness-callable via reap().
  // The scheduler-heartbeat staleness check (docs/27 R1-5) piggybacks here — the reap cycle is the one
  // recurring in-process loop that is default-ON in prod, so a silently-dead due-sweep trigger (cron/tick)
  // is detected even though the trigger itself lives outside the process.
  async maybeReap(): Promise<void> {
    const now = Date.now();
    if (now - this.lastReapAt < this.reapMs) return;
    this.lastReapAt = now;
    try { await this.queue.reapStuck(); } catch (e: any) { this.log.error(`reap failed: ${e?.message ?? e}`); }
    try { await this.heartbeat?.checkStale(); } catch (e: any) { this.log.error(`heartbeat check failed: ${e?.message ?? e}`); }
  }

  // Deterministic entry point for harnesses (the poll loop is off under tests).
  async reap(staleMs?: number): Promise<{ requeued: number; deadLettered: number }> {
    return this.queue.reapStuck(staleMs);
  }

  // Run claimed jobs until the queue is empty (or the process is stopping). Returns the number processed.
  async drain(max = 100): Promise<number> {
    let n = 0;
    while (!this.stopped && n < max) {
      const did = await this.tick();
      if (!did) break;
      n++;
    }
    return n;
  }

  // Claim and run exactly one job. Returns false when the queue is empty. Public so harnesses can step it.
  async tick(): Promise<boolean> {
    let job: ClaimedJob | null = null;
    try { job = await this.queue.claimNext(); } catch (e: any) { this.log.error(`claim failed: ${e?.message ?? e}`); return false; }
    if (!job) return false;

    const handler = this.handlers.get(job.jobType);
    if (!handler) {
      await this.queue.markFailed(job, `no handler registered for job_type '${job.jobType}'`);
      return true;
    }
    const ctx: JobContext = { tenantId: job.tenantId, actor: job.actor, bypass: job.bypass, attempt: job.attempts };
    try {
      // Run the handler in the job's own tenant transaction (RLS-scoped just like a request).
      const result = await runInTenantContext(this.db, { tenantId: job.tenantId, bypass: job.bypass, actor: job.actor }, () => handler(job!.payload, ctx));
      await this.queue.markDone(job.id, result);
    } catch (e: any) {
      this.log.warn(`job ${job.id} (${job.jobType}) failed attempt ${job.attempts}: ${e?.message ?? e}`);
      await this.queue.markFailed(job, String(e?.message ?? e));
    }
    return true;
  }
}

import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { captureOpsAlert } from '../../observability/instrumentation';
import { BiService } from './bi.service';

// 2.7 / AUD-ARC-07 — the OPTIONAL in-process scheduler tick, mirroring the JobWorker poll-loop shape.
//
//   SCHEDULER_TICK_MS unset/0 (default, CI/PGlite and every existing deploy) → OFF: scheduling stays with
//   the external cron (deployment.md §5), behavior unchanged (default-inert).
//   SCHEDULER_TICK_MS set (e.g. 300000 = 5 min) → the API self-triggers the cross-tenant due sweep
//   (bi.runDueAllAsync), removing the external-cron single point of failure.
//
// Multi-replica safety: two nodes ticking concurrently just enqueue duplicates, and the
// report_subscription handler re-checks dueness at execution time — the duplicate no-ops. No distributed
// lock needed (an advisory lock would pin lock/unlock to one pooled connection and add a failure mode for
// zero correctness gain). Tick failures alert (throttled) rather than dying silently.
@Injectable()
export class SchedulerTickService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('SchedulerTick');
  private readonly tickMs = Number(process.env.SCHEDULER_TICK_MS ?? 0);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private ticking = false;
  private lastAlertAt = 0;
  /** True when the loop was armed at bootstrap (prod + SCHEDULER_TICK_MS > 0). */
  armed = false;

  constructor(private readonly bi: BiService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test' || !(this.tickMs > 0)) {
      this.log.log('in-process scheduler tick OFF (SCHEDULER_TICK_MS unset/0) — due sweeps ride the external cron');
      return;
    }
    this.armed = true;
    this.log.log(`in-process scheduler tick ON — cross-tenant due sweep every ${this.tickMs}ms`);
    this.schedule();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tickOnce().finally(() => this.schedule()); }, this.tickMs);
  }

  // One sweep. Public so harnesses can step it deterministically (the loop is off under NODE_ENV=test).
  async tickOnce(): Promise<{ skipped?: string; due?: number; enqueued?: number; error?: string }> {
    if (this.ticking) return { skipped: 'overlap' }; // a slow sweep must not stack a second one
    this.ticking = true;
    try {
      return await this.bi.runDueAllAsync('system:scheduler-tick');
    } catch (e: any) {
      const now = Date.now();
      if (now - this.lastAlertAt >= 3600_000) {
        this.lastAlertAt = now;
        captureOpsAlert('scheduler_tick_failed', { hint: 'in-process due sweep threw — subscriptions are not being scheduled from this node' }, e);
      }
      this.log.error(`tick failed: ${e?.message ?? e}`);
      return { error: String(e?.message ?? e) };
    } finally {
      this.ticking = false;
    }
  }
}

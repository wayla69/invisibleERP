import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { schedulerHeartbeats } from '../../database/schema';
import { captureOpsAlert } from '../../observability/instrumentation';

// Scheduler heartbeat (docs/27 R1-5 residual / AUD-ARC-07). Every due-sweep — the external GitHub cron,
// a manual run, or the optional in-process tick — stamps its scheduler's row; the job worker's reap cycle
// calls checkStale() so a scheduler that WAS working and silently died (deleted workflow, expired
// SWEEP_API_KEY, crashed tick) raises a throttled ops alert instead of nothing ever running again.
const DEFAULT_STALE_HOURS = 26; // daily cron + slack; tune via SCHEDULER_STALE_HOURS

export type HeartbeatStatus = { status: 'never' | 'ok' | 'stale'; last_run_at?: string; age_ms?: number; stale_after_ms?: number };

@Injectable()
export class SchedulerHeartbeatService {
  private lastAlertAt = 0;
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  // Stamp "the scheduler ran now" — best-effort: a heartbeat failure must never poison the sweep it rides.
  async beat(name: string, source: string, detail?: Record<string, unknown>): Promise<void> {
    try {
      await this.db.insert(schedulerHeartbeats)
        .values({ name, source, detail: detail ?? null, lastRunAt: new Date() })
        .onConflictDoUpdate({ target: schedulerHeartbeats.name, set: { lastRunAt: new Date(), source, detail: detail ?? null } });
    } catch { /* best-effort */ }
  }

  // Detective check: a row that EXISTS but is older than the threshold means scheduling silently died →
  // throttled (1/h) ops alert. NO row = this deploy never scheduled anything — not an incident (a fresh
  // install without subscriptions must not page anyone).
  async checkStale(name = 'bi_scheduler', staleMs?: number): Promise<HeartbeatStatus> {
    const ms = staleMs ?? Number(process.env.SCHEDULER_STALE_HOURS ?? DEFAULT_STALE_HOURS) * 3600_000;
    let row: typeof schedulerHeartbeats.$inferSelect | undefined;
    try {
      [row] = await this.db.select().from(schedulerHeartbeats).where(eq(schedulerHeartbeats.name, name)).limit(1);
    } catch { return { status: 'never' }; } // table unreadable ⇒ don't page on infra noise; reap logs it
    if (!row) return { status: 'never' };
    const last = new Date(row.lastRunAt as unknown as string | Date).getTime();
    const age = Date.now() - last;
    const out: HeartbeatStatus = { status: age <= ms ? 'ok' : 'stale', last_run_at: new Date(last).toISOString(), age_ms: age, stale_after_ms: ms };
    if (out.status === 'stale') {
      const now = Date.now();
      if (now - this.lastAlertAt >= 3600_000) {
        this.lastAlertAt = now;
        captureOpsAlert('scheduler_heartbeat_stale', {
          scheduler: name, last_run_at: out.last_run_at, age_hours: Math.round(age / 3600_000),
          hint: 'the due-sweep trigger died silently — check the bi-scheduler workflow / SWEEP_API_KEY / SCHEDULER_TICK_MS node',
        });
      }
    }
    return out;
  }
}

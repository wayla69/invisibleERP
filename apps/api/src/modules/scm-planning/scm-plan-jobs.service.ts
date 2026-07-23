import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type DrizzleDb } from '../../database/database.module';
import { scmSpikeEvents } from '../../database/schema';
import { ymd } from '../../database/queries';
import { JobWorkerService, type JobContext } from '../jobs/job-worker.service';
import { ScmPlanningService } from './scm-planning.service';
import { SCM_BATCH_RETRAIN_JOB, SCM_NIGHTLY_JOB, SCM_REPLAN_JOB, SYSTEM_ACTOR } from './scm-planning.types';

// docs/54 §5 — background execution. Both job types ride the EXISTING background_jobs queue
// (FOR UPDATE SKIP LOCKED claim, exponential backoff, dead-letter + captureOpsAlert), so job
// failure alerting (ITGC-OP-04) comes for free. The worker re-establishes tenant context per job,
// so handlers run RLS-scoped exactly like a request.

@Injectable()
export class ScmPlanJobsService implements OnModuleInit {
  private readonly log = new Logger(ScmPlanJobsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly planning: ScmPlanningService,
    private readonly worker: JobWorkerService,
  ) {}

  onModuleInit(): void {
    this.worker?.register(SCM_NIGHTLY_JOB, (payload, ctx) => this.runNightly(payload, ctx));
    this.worker?.register(SCM_REPLAN_JOB, (payload, ctx) => this.runReplan(payload, ctx));
    this.worker?.register(SCM_BATCH_RETRAIN_JOB, (payload, ctx) => this.runRetrain(payload, ctx));
  }

  /**
   * docs/59 D1 — scheduled batch retrain. Moves the expensive forecast (cmdstan refit) OFF the request
   * path onto a cadence: it forecasts every planning-enabled series and PERSISTS the reconciled sample
   * paths (scm_demand_forecasts.sample_paths), which a later nightly plan then consumes without
   * re-forecasting. Same idempotency as nightly — a per-(tenant, run_date) partial unique index (0477)
   * + the executePlanRun guard make a duplicate scheduler tick a no-op.
   */
  private async runRetrain(payload: { run_date?: string }, ctx: JobContext) {
    const result = await this.planning.executePlanRun(ctx.tenantId, 'retrain', {
      actor: ctx.actor ?? SYSTEM_ACTOR,
    });
    if (result.skipped) {
      this.log.log(`batch retrain already done for tenant=${ctx.tenantId} ${payload.run_date ?? ymd()}`);
      return { skipped: true, run_no: result.run_no };
    }
    return { run_no: result.run_no, series: result.series };
  }

  /**
   * Nightly full plan. Idempotent twice over: the run row carries a partial unique index on
   * (tenant, run_date) for non-failed nightly runs, and executePlanRun short-circuits when one
   * already exists — so a duplicate enqueue (multi-replica scheduler tick) plans once.
   */
  private async runNightly(payload: { run_date?: string }, ctx: JobContext) {
    const result = await this.planning.executePlanRun(ctx.tenantId, 'nightly', {
      actor: ctx.actor ?? SYSTEM_ACTOR,
    });
    if (result.skipped) {
      this.log.log(`nightly plan already done for tenant=${ctx.tenantId} ${payload.run_date ?? ymd()}`);
      return { skipped: true, run_no: result.run_no };
    }
    const retention = Number(process.env.SCM_PLAN_RETENTION_DAYS ?? 90);
    const pruned = await this.planning.pruneOldRuns(ctx.tenantId, retention).catch(() => ({ pruned: 0 }));
    return { run_no: result.run_no, plans: result.plans, lines: result.lines, pruned: pruned.pruned };
  }

  /**
   * Spike replan — a small, targeted run over the spiking branch + items.
   * Idempotent: only events still Open proceed, and they flip to Replanned with the new run id.
   */
  private async runReplan(
    payload: { branch_id?: number | null; item_ids?: string[]; spike_event_ids?: number[] },
    ctx: JobContext,
  ) {
    const ids = payload.spike_event_ids ?? [];
    if (ids.length) {
      const open = await this.db.select({ id: scmSpikeEvents.id }).from(scmSpikeEvents).where(and(
        inArray(scmSpikeEvents.id, ids),
        eq(scmSpikeEvents.status, 'Open'),
        ctx.tenantId != null ? eq(scmSpikeEvents.tenantId, ctx.tenantId) : sql`true`,
      ));
      if (!open.length) return { skipped: true, reason: 'no open spike events' };
    }

    const result = await this.planning.executePlanRun(ctx.tenantId, 'replan', {
      actor: ctx.actor ?? SYSTEM_ACTOR,
      branchIds: [payload.branch_id ?? null],
      itemIds: payload.item_ids,
      triggerRef: ids.length ? `SPIKE:${ids.join(',')}` : undefined,
    });

    if (ids.length) {
      await this.db.update(scmSpikeEvents)
        .set({ status: 'Replanned', replanRunId: result.run_id })
        .where(and(
          inArray(scmSpikeEvents.id, ids),
          eq(scmSpikeEvents.status, 'Open'),
          ctx.tenantId != null ? eq(scmSpikeEvents.tenantId, ctx.tenantId) : sql`true`,
        ));
    }
    return { run_no: result.run_no, plans: result.plans, lines: result.lines, spikes: ids.length };
  }
}

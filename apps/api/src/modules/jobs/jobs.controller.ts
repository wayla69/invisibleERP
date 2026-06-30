import { Controller, Get, Param, Query } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { JobQueueService } from './job-queue.service';
import { runtimeMetrics } from '../../observability/runtime-metrics';

// Read-only status surface for async jobs. RLS-scoped: a tenant only sees its own jobs (the service reads
// inside the request's tenant tx). Gated by `dashboard` — any authenticated staff principal can poll the
// status of a job they kicked off (e.g. a payroll run).
@Controller('api/jobs')
export class JobsController {
  constructor(private readonly queue: JobQueueService) {}

  // Operational metrics (ITGC-OP-04 + capacity visibility). Cross-tenant, so gated by `users` (the ops/
  // admin duty) — NOT the per-tenant `dashboard`. Declared BEFORE the `:id` route so it isn't captured as
  // a job id. Surfaces DB-pool saturation, slow-request counts, and the job dead-letter/stuck backlog —
  // the inputs to an external alert rule (e.g. page when jobs.stuck > 0 or pool.saturation_pct high).
  @Get('ops-metrics') @Permissions('users')
  async opsMetrics() {
    const jobs = await this.queue.opsCounts();
    const rt = runtimeMetrics();
    const poolMax = Number(process.env.DB_POOL_MAX ?? 20);
    return {
      pool: {
        max: poolMax,
        in_flight_tx: rt.in_flight_tx,
        peak_in_flight_tx: rt.peak_in_flight_tx,
        saturation_pct: poolMax > 0 ? Math.round((rt.in_flight_tx / poolMax) * 100) : 0,
      },
      requests: { total_tx: rt.total_tx, slow_tx_count: rt.slow_tx_count, slow_threshold_ms: Number(process.env.SLOW_TX_MS ?? 1000) },
      jobs, // { queued, running, failed, stuck } — failed = dead-letters; stuck = zombie 'running' past threshold
    };
  }

  @Get() @Permissions('dashboard')
  list(@Query('type') type: string | undefined, @CurrentUser() u: JwtUser) { return this.queue.listJobs(type, u); }

  @Get(':id') @Permissions('dashboard')
  async get(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    const job = await this.queue.getJob(+id, u);
    return job ?? { error: { code: 'NOT_FOUND', message: 'Job not found', messageTh: 'ไม่พบงาน' } };
  }
}

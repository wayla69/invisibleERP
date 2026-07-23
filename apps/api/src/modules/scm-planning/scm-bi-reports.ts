import { Injectable } from '@nestjs/common';
import type { BiReportGenerator, BiReportSource } from '../bi/report-registry';
import type { JwtUser } from '../../common/decorators';
import { ymd } from '../../database/queries';
import { JobQueueService } from '../jobs/job-queue.service';
import { ScmPlanningService } from './scm-planning.service';
import { ScmSpikeService } from './scm-spike.service';
import { SCM_BATCH_RETRAIN_JOB, SCM_NIGHTLY_JOB } from './scm-planning.types';

// docs/54 §5 — cadence. These ride the BI report scheduler exactly like ar_collections_dunning:
// a tenant subscribes at a frequency, the cross-tenant sweep (bi-schedule runDueAllAsync) enqueues
// each due subscription under ITS OWN tenant, and a generator failure raises the standard
// scheduled_job_failed ops alert + Admin notification. No new scheduling machinery.

@Injectable()
export class ScmBiReports implements BiReportSource {
  constructor(
    private readonly planning: ScmPlanningService,
    private readonly spikes: ScmSpikeService,
    private readonly jobs: JobQueueService,
  ) {}

  biReports(): BiReportGenerator[] {
    return [
      {
        // ACTION job: enqueue the nightly plan rather than running it inline — a 33-branch run is
        // minutes of solver time and belongs on the queue (retry/backoff/dead-letter included).
        type: SCM_NIGHTLY_JOB,
        generate: async (_filters: unknown, user: JwtUser) => {
          const jobId = await this.jobs.enqueue({
            jobType: SCM_NIGHTLY_JOB,
            payload: { run_date: ymd() },
            tenantId: user.tenantId ?? null,
            actor: user.username,
          });
          return {
            data: { job_id: jobId, run_date: ymd() },
            summary: `Nightly supply-chain plan queued (job ${jobId})`,
            summaryTh: `เข้าคิววางแผนซัพพลายเชนประจำคืนแล้ว (งาน ${jobId})`,
          };
        },
      },
      {
        // docs/59 D1 ACTION job: enqueue the batch retrain — forecasts every series + persists the
        // reconciled sample paths a later nightly plan reads (moves refit off the request path).
        type: SCM_BATCH_RETRAIN_JOB,
        generate: async (_filters: unknown, user: JwtUser) => {
          const jobId = await this.jobs.enqueue({
            jobType: SCM_BATCH_RETRAIN_JOB,
            payload: { run_date: ymd() },
            tenantId: user.tenantId ?? null,
            actor: user.username,
          });
          return {
            data: { job_id: jobId, run_date: ymd() },
            summary: `Supply-chain batch retrain queued (job ${jobId})`,
            summaryTh: `เข้าคิวเทรนโมเดลซัพพลายเชนใหม่แล้ว (งาน ${jobId})`,
          };
        },
      },
      {
        // ACTION job: the spike micro-batch is cheap, so it runs inline. Its watermark makes any
        // cadence idempotent — daily via the scheduler, or hourly via POST /spikes/scan.
        type: 'scm_spike_scan',
        generate: async (_filters: unknown, user: JwtUser) => {
          const res = await this.spikes.scanTenant(user.tenantId ?? null, user.username);
          return {
            data: res,
            summary: `Demand-spike scan: ${res.spikes} new event(s) across ${res.scanned} series, ${res.replans} replan job(s)`,
            summaryTh: `ตรวจจับดีมานด์พุ่ง: พบใหม่ ${res.spikes} รายการ จาก ${res.scanned} ชุดข้อมูล และสั่งวางแผนใหม่ ${res.replans} งาน`,
          };
        },
      },
      {
        // Read-only digest for LINE/email delivery — what needs a human right now.
        type: 'scm_plan_summary',
        generate: async (_filters: unknown, user: JwtUser) => {
          const [pending, spikes, runs] = await Promise.all([
            this.planning.listPlans(user, { status: 'PendingApproval', limit: 100 }),
            this.planning.listSpikes(user, { status: 'Open', limit: 100 }),
            this.planning.listRuns(user, 1),
          ]);
          const last = runs.runs[0];
          const value = pending.plans.reduce((a, p) => a + Number(p.estTotalCost ?? 0), 0);
          return {
            data: {
              pending_plans: pending.plans.length,
              pending_value: Math.round(value * 100) / 100,
              open_spikes: spikes.spikes.length,
              last_run: last ? { run_no: last.runNo, status: last.status, engine: last.engine } : null,
            },
            summary: `${pending.plans.length} plan(s) awaiting approval (฿${Math.round(value).toLocaleString()}), ${spikes.spikes.length} open demand spike(s)`,
            summaryTh: `มีแผนรออนุมัติ ${pending.plans.length} รายการ (฿${Math.round(value).toLocaleString()}) และดีมานด์พุ่งที่ยังไม่จัดการ ${spikes.spikes.length} รายการ`,
          };
        },
      },
    ];
  }
}

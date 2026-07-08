import { Global, Module } from '@nestjs/common';
import { JobQueueService } from './job-queue.service';
import { JobWorkerService } from './job-worker.service';
import { SchedulerHeartbeatService } from './scheduler-heartbeat.service';
import { JobsController } from './jobs.controller';

// @Global so any module can inject JobQueueService (to enqueue) and JobWorkerService (to register a
// handler in its OnModuleInit) without importing JobsModule everywhere. SchedulerHeartbeatService rides
// along so due-sweeps can beat() and the worker's reap cycle can checkStale() (docs/27 R1-5).
@Global()
@Module({
  controllers: [JobsController],
  providers: [JobQueueService, JobWorkerService, SchedulerHeartbeatService],
  exports: [JobQueueService, JobWorkerService, SchedulerHeartbeatService],
})
export class JobsModule {}

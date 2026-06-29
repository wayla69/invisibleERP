import { Global, Module } from '@nestjs/common';
import { JobQueueService } from './job-queue.service';
import { JobWorkerService } from './job-worker.service';
import { JobsController } from './jobs.controller';

// @Global so any module can inject JobQueueService (to enqueue) and JobWorkerService (to register a
// handler in its OnModuleInit) without importing JobsModule everywhere.
@Global()
@Module({
  controllers: [JobsController],
  providers: [JobQueueService, JobWorkerService],
  exports: [JobQueueService, JobWorkerService],
})
export class JobsModule {}

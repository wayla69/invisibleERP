import { Controller, Get, Param, Query } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { JobQueueService } from './job-queue.service';

// Read-only status surface for async jobs. RLS-scoped: a tenant only sees its own jobs (the service reads
// inside the request's tenant tx). Gated by `dashboard` — any authenticated staff principal can poll the
// status of a job they kicked off (e.g. a payroll run).
@Controller('api/jobs')
export class JobsController {
  constructor(private readonly queue: JobQueueService) {}

  @Get() @Permissions('dashboard')
  list(@Query('type') type: string | undefined, @CurrentUser() u: JwtUser) { return this.queue.listJobs(type, u); }

  @Get(':id') @Permissions('dashboard')
  async get(@Param('id') id: string, @CurrentUser() u: JwtUser) {
    const job = await this.queue.getJob(+id, u);
    return job ?? { error: { code: 'NOT_FOUND', message: 'Job not found', messageTh: 'ไม่พบงาน' } };
  }
}

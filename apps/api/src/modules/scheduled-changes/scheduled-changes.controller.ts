import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ScheduledChangesService, type ScheduleDto } from './scheduled-changes.service';

const ScheduleBody = z.object({
  entity: z.string().min(1), entity_key: z.string().min(1), field: z.string().min(1),
  new_value: z.union([z.string(), z.number()]).transform((v) => String(v)),
  effective_date: z.string().min(1), note: z.string().optional(),
});

// Date-effective (future-dated) master-data changes (master-data audit Phase 12). Scheduling + the manual
// run-due are gated to steward/exec duties; releasing a sensitive (credit-limit) change is gated to a
// distinct approver (approvals/exec) with the maker≠checker rule enforced in the service.
@Controller('api/scheduled-changes')
export class ScheduledChangesController {
  constructor(private readonly svc: ScheduledChangesService) {}

  @Get() @Permissions('masterdata', 'md_item', 'exec', 'ar', 'approvals')
  list(@Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.list(status, u); }

  @Post() @Permissions('masterdata', 'md_item', 'exec', 'ar')
  schedule(@Body(new ZodValidationPipe(ScheduleBody)) b: ScheduleDto, @CurrentUser() u: JwtUser) { return this.svc.schedule(b, u); }

  @Post(':id/approve') @Permissions('approvals', 'exec')
  approve(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.approve(+id, u); }

  @Post(':id/cancel') @Permissions('masterdata', 'md_item', 'exec', 'ar')
  cancel(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.cancel(+id, u); }

  @Post('run-due') @Permissions('masterdata', 'exec')
  runDue(@CurrentUser() u: JwtUser) { return this.svc.applyDue(u); }
}

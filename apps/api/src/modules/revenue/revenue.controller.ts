import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RevenueService } from './revenue.service';

const CreateScheduleBody = z.object({
  source_ref: z.string().optional(),
  total_amount: z.number().positive(),
  start_period: z.string().regex(/^\d{4}-\d{2}$/),
  months: z.number().int().min(1),
  currency: z.string().optional(),
  receipt_date: z.string().optional(),
  notes: z.string().optional(),
});
type CreateScheduleBodyT = z.infer<typeof CreateScheduleBody>;

// รายได้รอตัดบัญชี — defer prepaid cash to 2400 then recognize straight-line to 4000 over the term.
@Controller('api/revenue')
@Permissions('exec', 'ar')
export class RevenueController {
  constructor(private readonly svc: RevenueService) {}

  @Post('schedules')
  create(@Body(new ZodValidationPipe(CreateScheduleBody)) b: CreateScheduleBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.createSchedule({ ...b, tenantId: u.tenantId ?? null, createdBy: u.username });
  }

  @Get('schedules')
  list(@Query('status') status?: string, @Query('source_ref') ref?: string) { return this.svc.listSchedules({ status, source_ref: ref }); }

  @Post('recognize')
  recognize(@Query('period') period: string, @Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.runRecognition(period, u, tenantId != null && tenantId !== '' ? Number(tenantId) : null); }

  @Get('deferred')
  deferred(@Query('as_of') asOf?: string) { return this.svc.remainingDeferred(asOf); }
}

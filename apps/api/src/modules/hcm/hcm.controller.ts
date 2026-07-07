import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { HcmService, type TimesheetDto, type LeaveDto } from './hcm.service';

const TimesheetBody = z.object({ emp_code: z.string().min(1), work_date: z.string().optional(), regular_hours: z.number().nonnegative().optional(), ot_hours: z.number().nonnegative().optional(), note: z.string().optional(), project_code: z.string().optional(), task_id: z.number().int().positive().optional(), billable: z.boolean().optional() });
const LeaveBody = z.object({ emp_code: z.string().min(1), leave_type: z.string().optional(), from_date: z.string(), to_date: z.string(), days: z.number().positive(), paid: z.boolean().optional(), reason: z.string().optional() });

@Controller('api/hcm')
@Permissions('exec', 'users', 'creditors')
@RequiresSuite('hcm')
export class HcmController {
  constructor(private readonly svc: HcmService) {}

  @Post('timesheets')
  logTimesheet(@Body(new ZodValidationPipe(TimesheetBody)) b: TimesheetDto, @CurrentUser() u: JwtUser) { return this.svc.logTimesheet(b, u); }

  @Get('timesheets')
  listTimesheets(@Query('emp_code') empCode: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listTimesheets(empCode, u); }

  // Approve a timesheet (maker-checker → posts project labor if it targets a project) — PROJ-04.
  @Post('timesheets/:id/approve')
  approveTimesheet(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.approveTimesheet(Number(id), u); }

  @Post('leave')
  requestLeave(@Body(new ZodValidationPipe(LeaveBody)) b: LeaveDto, @CurrentUser() u: JwtUser) { return this.svc.requestLeave(b, u); }

  @Get('leave')
  listLeave(@CurrentUser() u: JwtUser) { return this.svc.listLeave(u); }

  @Post('leave/:id/approve')
  approveLeave(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.approveLeave(Number(id), u); }
}

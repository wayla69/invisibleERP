import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { HcmLeaveService, type LeaveTypeDto, type LeavePolicyDto } from './hcm-leave.service';

const LeaveTypeBody = z.object({
  code: z.string().min(1), name: z.string().min(1),
  accrual_method: z.enum(['monthly', 'anniversary', 'none']).optional(),
  accrual_rate_days: z.number().nonnegative().optional(), carryover_cap_days: z.number().nonnegative().optional(),
  max_balance_days: z.number().nonnegative().optional(), allow_negative: z.boolean().optional(), active: z.boolean().optional(),
});
const LeavePolicyBody = z.object({
  leave_type_code: z.string().min(1), job_grade: z.string().nullable().optional(),
  min_tenure_months: z.number().int().nonnegative().optional(), accrual_rate_days: z.number().nonnegative(),
});
const AccrualRunBody = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() });

// HR-2 (docs/42) — leave accrual configuration + run. Reads: hr/hr_admin/exec/ess; config + accrual run:
// hr_admin/exec. Extends the existing /api/hcm leave surface (HcmController) with the accrual engine.
@Controller('api/hcm/leave')
@Permissions('hr', 'hr_admin', 'exec')
@RequiresSuite('hcm')
export class HcmLeaveController {
  constructor(private readonly svc: HcmLeaveService) {}

  @Get('types') @Permissions('hr', 'hr_admin', 'exec', 'ess')
  listTypes(@CurrentUser() u: JwtUser) { return this.svc.listTypes(u); }

  @Post('types') @Permissions('hr_admin', 'exec')
  createType(@Body(new ZodValidationPipe(LeaveTypeBody)) b: LeaveTypeDto, @CurrentUser() u: JwtUser) { return this.svc.createType(b, u); }

  @Get('policies') @Permissions('hr', 'hr_admin', 'exec')
  listPolicies(@CurrentUser() u: JwtUser) { return this.svc.listPolicies(u); }

  @Post('policies') @Permissions('hr_admin', 'exec')
  createPolicy(@Body(new ZodValidationPipe(LeavePolicyBody)) b: LeavePolicyDto, @CurrentUser() u: JwtUser) { return this.svc.createPolicy(b, u); }

  @Get('balances') @Permissions('hr', 'hr_admin', 'exec', 'ess')
  balances(@Query('emp_code') empCode: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.balances(empCode, u); }

  @Post('accrual/run') @Permissions('hr_admin', 'exec')
  runAccrual(@Body(new ZodValidationPipe(AccrualRunBody)) b: { period?: string }, @CurrentUser() u: JwtUser) { return this.svc.runAccrual(u, b.period); }
}

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PayrollService, type EmployeeDto } from './payroll.service';

const EmployeeBody = z.object({
  name: z.string().min(1),
  emp_code: z.string().optional(),
  national_id: z.string().optional(),
  sso_no: z.string().optional(),
  position: z.string().optional(),
  department: z.string().optional(),
  monthly_salary: z.number().nonnegative(),
  hourly_rate: z.number().nonnegative().optional(),
  pf_rate: z.number().min(0).max(1).optional(),
  allowances: z.number().nonnegative().optional(),
  sso_eligible: z.boolean().optional(),
  bank_account: z.string().optional(),
  start_date: z.string().optional(),
});

const RejectBody = z.object({ reason: z.string().optional() });
const RemitBody = z.object({ account_code: z.string().min(1), amount: z.number().positive(), ref: z.string().optional() });

@Controller('api/payroll')
@Permissions('exec', 'users', 'creditors')
export class PayrollController {
  constructor(private readonly svc: PayrollService) {}

  @Post('employees')
  createEmployee(@Body(new ZodValidationPipe(EmployeeBody)) b: EmployeeDto, @CurrentUser() u: JwtUser) {
    return this.svc.createEmployee(b, u);
  }

  @Get('employees')
  listEmployees(@CurrentUser() u: JwtUser) {
    return this.svc.listEmployees(u);
  }

  @Post('runs')
  runPayroll(@Query('period') period: string, @Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.runPayroll(period, u, tenantId != null && tenantId !== '' ? Number(tenantId) : null);
  }

  // PAY-03 maker-checker: a different user approves (SoD-enforced) → the Draft payroll JE becomes effective.
  @Post('runs/:period/approve')
  approve(@Param('period') period: string, @Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.approvePayroll(period, u, tenantId != null && tenantId !== '' ? Number(tenantId) : null);
  }

  @Post('runs/:period/reject')
  reject(@Param('period') period: string, @Body(new ZodValidationPipe(RejectBody)) b: { reason?: string }, @Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.rejectPayroll(period, u, b?.reason, tenantId != null && tenantId !== '' ? Number(tenantId) : null);
  }

  @Get('runs')
  listRuns(@CurrentUser() u: JwtUser) {
    return this.svc.listRuns(u);
  }

  @Get('runs/:period/slips')
  getSlips(@Param('period') period: string, @CurrentUser() u: JwtUser) {
    return this.svc.getSlips(period, u);
  }

  @Get('pnd1')
  pnd1(@Query('period') period: string, @CurrentUser() u: JwtUser) {
    return this.svc.pnd1(period, u);
  }

  @Get('pnd1a')
  pnd1a(@Query('year') year: string, @CurrentUser() u: JwtUser) {
    return this.svc.pnd1a(year, u);
  }

  // PAY-02 — payroll-liability schedule (SSO/WHT/PF outstanding vs the payrun accrual) + cash remittance.
  @Get('liabilities')
  liabilities(@Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.liabilities(u, tenantId != null && tenantId !== '' ? Number(tenantId) : null);
  }

  @Post('liabilities/remit')
  remit(@Body(new ZodValidationPipe(RemitBody)) b: { account_code: string; amount: number; ref?: string }, @Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.remitLiability(b, u, tenantId != null && tenantId !== '' ? Number(tenantId) : null);
  }
}

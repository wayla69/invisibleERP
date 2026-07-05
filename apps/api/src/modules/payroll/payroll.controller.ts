import { Body, Controller, Get, Param, Post, Query, Optional, BadRequestException, HttpCode, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { JobQueueService } from '../jobs/job-queue.service';
import { PayrollService, type EmployeeDto, PAYROLL_RUN_JOB } from './payroll.service';

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
const DocEmailBody = z.object({ to_email: z.string().email() });

@Controller('api/payroll')
@Permissions('exec', 'users', 'creditors')
export class PayrollController {
  constructor(
    private readonly svc: PayrollService,
    @Optional() private readonly jobs?: JobQueueService,
  ) {}

  @Post('employees')
  createEmployee(@Body(new ZodValidationPipe(EmployeeBody)) b: EmployeeDto, @CurrentUser() u: JwtUser) {
    return this.svc.createEmployee(b, u);
  }

  @Get('employees')
  listEmployees(@CurrentUser() u: JwtUser) {
    return this.svc.listEmployees(u);
  }

  // Run payroll for a period. Synchronous by default (backward compatible). With ?async=1 the run is
  // enqueued as a background job and the request returns 202 immediately with a job_id to poll at
  // GET /api/jobs/:id — keeps a large run off the request thread (the run is idempotent per tenant+period).
  @Post('runs')
  async runPayroll(
    @Query('period') period: string,
    @Query('tenant_id') tenantId: string | undefined,
    @Query('async') async_: string | undefined,
    @CurrentUser() u: JwtUser,
  ) {
    const explicit = tenantId != null && tenantId !== '' ? Number(tenantId) : null;
    const wantAsync = async_ === '1' || async_ === 'true';
    if (wantAsync && this.jobs) {
      if (!/^\d{4}-\d{2}$/.test(period ?? '')) throw new BadRequestException({ code: 'BAD_PERIOD', message: 'period must be YYYY-MM', messageTh: 'งวดต้องเป็น YYYY-MM' });
      const target = u.tenantId ?? explicit;
      if (target == null) throw new BadRequestException({ code: 'TENANT_REQUIRED', message: 'HQ/Admin must specify tenant_id to run payroll', messageTh: 'สำนักงานใหญ่ต้องระบุ tenant_id เพื่อรันเงินเดือน' });
      const jobId = await this.jobs.enqueue({ jobType: PAYROLL_RUN_JOB, payload: { period }, tenantId: target, actor: u.username, bypass: u.role === 'Admin' });
      return { queued: true, job_id: jobId, status: 'queued', poll: `/api/jobs/${jobId}` };
    }
    return this.svc.runPayroll(period, u, explicit);
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

  // Printable สลิปเงินเดือน (payslip) for HR/payroll — HTML→PDF via the shared renderer (HTML fallback when
  // Chromium absent). The controller gate (exec/users/creditors) already restricts this to HR; an employee's
  // own-slip download is the separate PDPA-scoped ESS route (GET /api/ess/payslips/:id/pdf).
  @Get('slips/:id/pdf')
  async slipPdf(@Param('id') id: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const p = await this.svc.getSlipForPrint(Number(id), u);
    const buf = await this.svc.renderPayslipPdf(p);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="payslip-${p.slip_id}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(this.svc.payslipHtml(p));
  }

  @Post('slips/:id/send-email') @HttpCode(200)
  emailSlip(@Param('id') id: string, @Body(new ZodValidationPipe(DocEmailBody)) b: z.infer<typeof DocEmailBody>, @CurrentUser() u: JwtUser) {
    return this.svc.emailPayslip(Number(id), b.to_email, u);
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

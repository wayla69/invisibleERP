import { Controller, Get, Post, Param, Body, Module, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { FinanceModule } from '../finance/finance.module';
import { PayrollModule } from '../payroll/payroll.module';
import { EssService } from './ess.service';
import { MessagingModule } from '../messaging/messaging.module';
import { PosLoyaltyLaborModule } from '../pos/labor/pos-loyalty-labor.module';

const LeaveBody = z.object({ leave_type: z.string().optional(), from_date: z.string(), to_date: z.string(), days: z.number().positive(), paid: z.boolean().optional(), reason: z.string().optional() });
const ExpenseBody = z.object({ claim_date: z.string().optional(), category: z.string().optional(), amount: z.number().positive(), description: z.string().optional() });
const DecideBody = z.object({ approve: z.boolean(), self_approval_reason: z.string().max(500).optional() });

// Phase D3 — Employee Self-Service. All reads/writes self-scope to the logged-in employee (perm `ess`);
// expense approval is a manager action (perm `approvals`) with SoD (approver ≠ claimant).
@Controller('api/ess')
export class EssController {
  constructor(private readonly ess: EssService) {}

  @Get('me') @Permissions('ess') profile(@CurrentUser() u: JwtUser) { return this.ess.profile(u); }
  @Get('timesheets') @Permissions('ess') timesheets(@CurrentUser() u: JwtUser) { return this.ess.myTimesheets(u); }
  // My POS time-clock attendance (self-scoped in the service via me() → employee_id; RLS scopes the tenant).
  @Get('attendance') @Permissions('ess') attendance(@CurrentUser() u: JwtUser) { return this.ess.myAttendance(u); }
  @Get('leave') @Permissions('ess') leave(@CurrentUser() u: JwtUser) { return this.ess.myLeave(u); }
  @Post('leave') @Permissions('ess') requestLeave(@Body(new ZodValidationPipe(LeaveBody)) b: z.infer<typeof LeaveBody>, @CurrentUser() u: JwtUser) { return this.ess.requestLeave(b, u); }
  @Get('payslips') @Permissions('ess') payslips(@CurrentUser() u: JwtUser) { return this.ess.myPayslips(u); }
  // Employee's OWN payslip PDF (PDPA-scoped in the service via me() → employee_id predicate). Declared before
  // any `payslips/:id` write route would be; a slip id that isn't the caller's own resolves to 404.
  @Get('payslips/:id/pdf') @Permissions('ess')
  async payslipPdf(@Param('id') id: string, @CurrentUser() u: JwtUser, @Res() reply: FastifyReply) {
    const p = await this.ess.myPayslipForPrint(Number(id), u);
    const buf = await this.ess.renderPayslipPdf(p);
    if (buf) reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `inline; filename="payslip-${p.slip_id}.pdf"`).header('Content-Length', buf.length).send(buf);
    else reply.header('Content-Type', 'text/html; charset=utf-8').send(this.ess.payslipHtml(p));
  }
  @Get('expenses') @Permissions('ess') expenses(@CurrentUser() u: JwtUser) { return this.ess.myExpenses(u); }
  // Approver inbox — list every pending claim awaiting a decision (perm `approvals`, NOT self-scoped).
  // Declared before the `expenses/:id/decide` route so the literal `pending` segment is never captured as an id.
  @Get('expenses/pending') @Permissions('approvals') pendingExpenses() { return this.ess.listPendingExpenses(); }
  @Post('expenses') @Permissions('ess') submitExpense(@Body(new ZodValidationPipe(ExpenseBody)) b: z.infer<typeof ExpenseBody>, @CurrentUser() u: JwtUser) { return this.ess.submitExpense(b, u); }
  // SoD: approver ≠ claimant (SOD_SELF_APPROVAL).
  // (an 'sme' tenant may self-approve WITH self_approval_reason — docs/49, SME-01.)
  @Post('expenses/:id/decide') @Permissions('approvals') decide(@Param('id') id: string, @Body(new ZodValidationPipe(DecideBody)) b: z.infer<typeof DecideBody>, @CurrentUser() u: JwtUser) { return this.ess.approveExpense(+id, b.approve, u, b.self_approval_reason); }
}

@Module({ imports: [FinanceModule, MessagingModule, PayrollModule, PosLoyaltyLaborModule], controllers: [EssController], providers: [EssService] })
export class EssModule {}

import { Controller, Get, Post, Param, Body, Module } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { FinanceModule } from '../finance/finance.module';
import { EssService } from './ess.service';

const LeaveBody = z.object({ leave_type: z.string().optional(), from_date: z.string(), to_date: z.string(), days: z.number().positive(), paid: z.boolean().optional(), reason: z.string().optional() });
const ExpenseBody = z.object({ claim_date: z.string().optional(), category: z.string().optional(), amount: z.number().positive(), description: z.string().optional() });
const DecideBody = z.object({ approve: z.boolean() });

// Phase D3 — Employee Self-Service. All reads/writes self-scope to the logged-in employee (perm `ess`);
// expense approval is a manager action (perm `approvals`) with SoD (approver ≠ claimant).
@Controller('api/ess')
export class EssController {
  constructor(private readonly ess: EssService) {}

  @Get('me') @Permissions('ess') profile(@CurrentUser() u: JwtUser) { return this.ess.profile(u); }
  @Get('timesheets') @Permissions('ess') timesheets(@CurrentUser() u: JwtUser) { return this.ess.myTimesheets(u); }
  @Get('leave') @Permissions('ess') leave(@CurrentUser() u: JwtUser) { return this.ess.myLeave(u); }
  @Post('leave') @Permissions('ess') requestLeave(@Body(new ZodValidationPipe(LeaveBody)) b: z.infer<typeof LeaveBody>, @CurrentUser() u: JwtUser) { return this.ess.requestLeave(b, u); }
  @Get('payslips') @Permissions('ess') payslips(@CurrentUser() u: JwtUser) { return this.ess.myPayslips(u); }
  @Get('expenses') @Permissions('ess') expenses(@CurrentUser() u: JwtUser) { return this.ess.myExpenses(u); }
  // Approver inbox — list every pending claim awaiting a decision (perm `approvals`, NOT self-scoped).
  // Declared before the `expenses/:id/decide` route so the literal `pending` segment is never captured as an id.
  @Get('expenses/pending') @Permissions('approvals') pendingExpenses() { return this.ess.listPendingExpenses(); }
  @Post('expenses') @Permissions('ess') submitExpense(@Body(new ZodValidationPipe(ExpenseBody)) b: z.infer<typeof ExpenseBody>, @CurrentUser() u: JwtUser) { return this.ess.submitExpense(b, u); }
  @Post('expenses/:id/decide') @Permissions('approvals') decide(@Param('id') id: string, @Body(new ZodValidationPipe(DecideBody)) b: z.infer<typeof DecideBody>, @CurrentUser() u: JwtUser) { return this.ess.approveExpense(+id, b.approve, u); }
}

@Module({ imports: [FinanceModule], controllers: [EssController], providers: [EssService] })
export class EssModule {}

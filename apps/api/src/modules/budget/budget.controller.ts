import { Controller, Get, Post, Delete, Query, Body, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { BudgetService } from './budget.service';
import { qint, qintOpt } from '../../common/query';

const BudgetBody = z.object({
  fiscal_year: z.number().int(),
  account_code: z.string().min(1),
  cost_center_code: z.string().optional(),
  mode: z.enum(['annual', 'monthly']).default('annual'),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  amount: z.number(),
  notes: z.string().optional(),
}).refine((b) => b.mode !== 'monthly' || !!b.period, { message: 'period required for monthly mode' });
type BudgetBodyT = z.infer<typeof BudgetBody>;

const ApproveBudgetBody = z.object({
  fiscal_year: z.number().int(),
  account_code: z.string().min(1),
  cost_center_code: z.string().optional(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});
type ApproveBudgetBodyT = z.infer<typeof ApproveBudgetBody>;

const ReviewBody = z.object({
  fiscal_year: z.number().int(),
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  cost_center: z.string().optional(),
  notes: z.string().min(1),
});

// งบประมาณเทียบจริง — budgets (reference data, no GL) + budget-vs-actual variance report.
@Controller('api/ledger')
@Permissions('exec', 'planner')
export class BudgetController {
  constructor(private readonly svc: BudgetService) {}

  @Post('budgets')
  upsert(@Body(new ZodValidationPipe(BudgetBody)) b: BudgetBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.upsertBudget({ ...b, tenantId: u.tenantId ?? null, createdBy: u.username });
  }

  @Get('budgets')
  list(@Query('fiscal_year') fy?: string, @Query('account_code') account?: string, @Query('cost_center_code') cc?: string, @Query('status') status?: string) {
    return this.svc.listBudgets({ fiscal_year: qintOpt('fiscal_year', fy), account_code: account, cost_center_code: cc, status });
  }

  // BUD-01 maker-checker. upsert (above) requests a budget (PendingApproval, excluded from budget-vs-actual);
  // a DIFFERENT user with approval authority approves/rejects it (approver ≠ requester enforced, binds Admin).
  @Get('budgets/pending') @Permissions('approvals', 'gl_close', 'exec')
  pendingBudgets(@Query('fiscal_year') fy?: string) { return this.svc.listBudgets({ fiscal_year: qintOpt('fiscal_year', fy), status: 'PendingApproval' }); }
  @Post('budgets/approve') @HttpCode(200) @Permissions('approvals', 'gl_close')
  approveBudget(@Body(new ZodValidationPipe(ApproveBudgetBody)) b: ApproveBudgetBodyT, @CurrentUser() u: JwtUser) { return this.svc.approveBudget({ ...b, tenantId: u.tenantId ?? null }, u); }
  @Post('budgets/reject') @HttpCode(200) @Permissions('approvals', 'gl_close')
  rejectBudget(@Body(new ZodValidationPipe(ApproveBudgetBody)) b: ApproveBudgetBodyT, @CurrentUser() u: JwtUser) { return this.svc.rejectBudget({ ...b, tenantId: u.tenantId ?? null }, u); }

  @Delete('budgets')
  remove(@Query('fiscal_year') fy: string, @Query('account_code') account: string, @Query('cost_center_code') cc?: string, @Query('period') period?: string) {
    return this.svc.deleteBudget({ fiscal_year: +fy, account_code: account, cost_center_code: cc, period });
  }

  @Get('budget-vs-actual')
  report(@Query('fiscal_year') fy: string, @Query('period') period?: string, @Query('cost_center') cc?: string) {
    return this.svc.budgetVsActual({ fiscal_year: +fy, period, cost_center: cc });
  }

  // ELC-06 — management budget-variance review: record a sign-off + list the review history (evidence).
  @Post('budget-review/sign-off') @HttpCode(200) @Permissions('exec', 'approvals', 'gl_close')
  signOff(@Body(new ZodValidationPipe(ReviewBody)) b: z.infer<typeof ReviewBody>, @CurrentUser() u: JwtUser) {
    return this.svc.signOffReview(b, u);
  }
  @Get('budget-reviews') @Permissions('exec', 'planner', 'approvals')
  reviews(@Query('fiscal_year') fy?: string) { return this.svc.listReviews(qintOpt('fiscal_year', fy)); }
}

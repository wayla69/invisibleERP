import { Controller, Get, Post, Delete, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { BudgetService } from './budget.service';

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
  list(@Query('fiscal_year') fy?: string, @Query('account_code') account?: string, @Query('cost_center_code') cc?: string) {
    return this.svc.listBudgets({ fiscal_year: fy ? +fy : undefined, account_code: account, cost_center_code: cc });
  }

  @Delete('budgets')
  remove(@Query('fiscal_year') fy: string, @Query('account_code') account: string, @Query('cost_center_code') cc?: string, @Query('period') period?: string) {
    return this.svc.deleteBudget({ fiscal_year: +fy, account_code: account, cost_center_code: cc, period });
  }

  @Get('budget-vs-actual')
  report(@Query('fiscal_year') fy: string, @Query('period') period?: string, @Query('cost_center') cc?: string) {
    return this.svc.budgetVsActual({ fiscal_year: +fy, period, cost_center: cc });
  }
}

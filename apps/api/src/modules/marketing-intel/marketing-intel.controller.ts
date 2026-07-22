import { Controller, Get, Post, Body, Query, Param } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  MarketingIntelService,
  SimulateBody, OptimizeBody, StageBudgetPlanBody, ApproveBudgetPlanBody,
} from './marketing-intel.service';

const ActivateBody = z.object({
  segment: z.string().min(1).max(80),
  channel: z.enum(['sms', 'email', 'line']).optional(),
  body: z.string().min(1).max(1000).optional(),
});

// Internal read + action surface for the /marketing-intel web page. Gated to the marketing/exec duties
// (the CRM / campaigns audience). The WRITE side (the platform push) is the public API — see
// PublicApiController POST /api/v1/analytics/snapshots (scope analytics:write).
@Controller('api/marketing-intel')
export class MarketingIntelController {
  constructor(private readonly svc: MarketingIntelService) {}

  @Get('summary')
  @Permissions('marketing', 'exec')
  summary(@CurrentUser() u: JwtUser) {
    return this.svc.getSummary(u);
  }

  @Get('mmm-history')
  @Permissions('marketing', 'exec')
  mmmHistory(@CurrentUser() u: JwtUser) {
    return this.svc.getMmmHistory(u);
  }

  @Get('segments')
  @Permissions('marketing', 'exec')
  segments(@CurrentUser() u: JwtUser) {
    return this.svc.segmentCounts(u);
  }

  // Customer Intelligence drill-down (docs/60 Phase 2, MKT-18) — the members of a pushed segment with the
  // platform's per-customer CLV / churn / next-best-action. Read-only + advisory; gated marketing/exec.
  @Get('segment/:segment/customers')
  @Permissions('marketing', 'exec')
  segmentCustomers(
    @Param('segment') segment: string,
    @Query('sort') sort: string | undefined,
    @CurrentUser() u: JwtUser,
  ) {
    return this.svc.segmentDrilldown(u, { segment, sort: sort === 'churn' ? 'churn' : 'clv' });
  }

  // Turn a pushed RFM segment into a DRAFT campaign (audience=mi_segment) — the action loop. Gated to the
  // campaign-creating duties (mirrors POST /api/campaigns).
  @Post('segments/activate')
  @Permissions('crm_campaign', 'marketing', 'exec')
  activate(@Body(new ZodValidationPipe(ActivateBody)) b: z.infer<typeof ActivateBody>, @CurrentUser() u: JwtUser) {
    return this.svc.activateSegment(b, u);
  }

  // ─── Budget Optimizer (docs/60 Phase 1, control MKT-17) ──────────────────────────────────────────────
  @Get('response-curves')
  @Permissions('marketing', 'exec')
  responseCurves(@CurrentUser() u: JwtUser) {
    return this.svc.responseCurves(u);
  }

  @Post('simulate')
  @Permissions('marketing', 'exec')
  simulate(@Body(new ZodValidationPipe(SimulateBody)) b: z.infer<typeof SimulateBody>, @CurrentUser() u: JwtUser) {
    return this.svc.simulate(u, b);
  }

  @Post('optimize')
  @Permissions('marketing', 'exec')
  optimize(@Body(new ZodValidationPipe(OptimizeBody)) b: z.infer<typeof OptimizeBody>, @CurrentUser() u: JwtUser) {
    return this.svc.optimize(u, b);
  }

  @Get('budget-plans')
  @Permissions('marketing', 'exec')
  budgetPlans(@CurrentUser() u: JwtUser) {
    return this.svc.listBudgetPlans(u);
  }

  // STAGE a budget plan (advisory; never posts spend). A DIFFERENT user must approve it.
  @Post('budget-plan')
  @Permissions('marketing', 'exec', 'pr_raise')
  stageBudgetPlan(@Body(new ZodValidationPipe(StageBudgetPlanBody)) b: z.infer<typeof StageBudgetPlanBody>, @CurrentUser() u: JwtUser) {
    return this.svc.stageBudgetPlan(u, b);
  }

  // APPROVE a staged plan — maker-checker (approver ≠ requester), gated to the approver duties.
  @Post('budget-plan/approve')
  @Permissions('exec', 'approvals')
  approveBudgetPlan(@Body(new ZodValidationPipe(ApproveBudgetPlanBody)) b: z.infer<typeof ApproveBudgetPlanBody>, @CurrentUser() u: JwtUser) {
    return this.svc.approveBudgetPlan(u, b);
  }
}

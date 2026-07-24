import { Controller, Get, Post, Put, Body, Query, Param } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  MarketingIntelService,
  SimulateBody, OptimizeBody, StageBudgetPlanBody, ApproveBudgetPlanBody,
} from './marketing-intel.service';
import { MiExperimentsService, StartExperimentBody, MeasureExperimentBody } from './mi-experiments.service';
import { MiGovernanceService, GovernanceSettingsBody, ApproveRunBody } from './mi-governance.service';
import { MiBacktestService } from './mi-backtest.service';

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
  constructor(
    private readonly svc: MarketingIntelService,
    private readonly experiments: MiExperimentsService,
    private readonly governance: MiGovernanceService,
    private readonly backtest: MiBacktestService,
  ) {}

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

  // docs/62 Phase 2 (MKT-26, detective) — reconcile an APPROVED plan against actual per-channel spend.
  @Get('budget-plan/:planNo/backtest')
  @Permissions('marketing', 'exec')
  backtestPlan(@Param('planNo') planNo: string, @CurrentUser() u: JwtUser) {
    return this.backtest.backtestPlan(u, planNo);
  }

  // ─── Closed-loop Measurement (docs/60 Phase 3, control MKT-19) ───────────────────────────────────────
  @Get('experiments')
  @Permissions('marketing', 'exec')
  experiments_(@CurrentUser() u: JwtUser) {
    return this.experiments.listExperiments(u);
  }

  // START an experiment: fix treatment/control arms (+ optionally send the treatment-only campaign).
  @Post('experiments')
  @Permissions('crm_campaign', 'marketing', 'exec')
  startExperiment(@Body(new ZodValidationPipe(StartExperimentBody)) b: z.infer<typeof StartExperimentBody>, @CurrentUser() u: JwtUser) {
    return this.experiments.startExperiment(u, b);
  }

  // MEASURE lift once the window has elapsed (read-only outcome).
  @Post('experiments/measure')
  @Permissions('marketing', 'exec')
  measureExperiment(@Body(new ZodValidationPipe(MeasureExperimentBody)) b: z.infer<typeof MeasureExperimentBody>, @CurrentUser() u: JwtUser) {
    return this.experiments.measureExperiment(u, b);
  }

  // ─── Model Governance (docs/60 Phase 4, control MKT-20) ──────────────────────────────────────────────
  @Get('governance/settings')
  @Permissions('marketing', 'exec')
  governanceSettings(@CurrentUser() u: JwtUser) {
    return this.governance.getSettings(u);
  }

  @Put('governance/settings')
  @Permissions('exec', 'approvals')
  updateGovernanceSettings(@Body(new ZodValidationPipe(GovernanceSettingsBody)) b: z.infer<typeof GovernanceSettingsBody>, @CurrentUser() u: JwtUser) {
    return this.governance.updateSettings(u, b);
  }

  // Model cards + drift + status per pushed run.
  @Get('governance/runs')
  @Permissions('marketing', 'exec')
  governanceRuns(@CurrentUser() u: JwtUser) {
    return this.governance.listRuns(u);
  }

  // APPROVE a pushed run — maker-checker (approver ≠ pusher); a drifted run needs a reason.
  @Post('governance/runs/approve')
  @Permissions('exec', 'approvals')
  approveRun(@Body(new ZodValidationPipe(ApproveRunBody)) b: z.infer<typeof ApproveRunBody>, @CurrentUser() u: JwtUser) {
    return this.governance.approveRun(u, b);
  }

  // The ICFR evidence chain: recommendation (run) → action (budget plan) → outcome (experiment lift).
  @Get('governance/audit-trail')
  @Permissions('marketing', 'exec')
  auditTrail(@CurrentUser() u: JwtUser) {
    return this.governance.auditTrail(u);
  }
}

import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Permissions, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { LaneBody, NodeBody, ScmNetworkService, type LaneDto, type NodeDto } from './scm-network.service';
import { ScmNetworkRunService } from './scm-network-run.service';
import { ScmNetworkPlanService, ApproveBody, RejectBody } from './scm-network-plan.service';

const RunBody = z.object({ item_code: z.string().min(1).max(64) });

// docs/57 Track B (B1) — supply-network master-data API.
//
// Topology is GOVERNED master data: gated by the PLANNER duty (`scm_plan`), same as the demand
// planning surface. B1 is definition only — CRUD + a validated topology view. The two-echelon
// optimizer and its maker-checker (SCM-05) arrive in B2 on this same module.

@Controller('api/scm-network')
@Permissions('scm_plan', 'exec')
export class ScmNetworkController {
  constructor(
    private readonly svc: ScmNetworkService,
    private readonly runner: ScmNetworkRunService,
    private readonly plans: ScmNetworkPlanService,
  ) {}

  // ── nodes ──
  @Get('nodes')
  listNodes(@CurrentUser() u: JwtUser) { return this.svc.listNodes(u); }

  @Post('nodes')
  upsertNode(@Body(new ZodValidationPipe(NodeBody)) b: NodeDto, @CurrentUser() u: JwtUser) {
    return this.svc.upsertNode(b, u);
  }

  @Delete('nodes/:id')
  deleteNode(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.svc.deleteNode(id, u);
  }

  // ── lanes ──
  @Get('lanes')
  listLanes(@CurrentUser() u: JwtUser) { return this.svc.listLanes(u); }

  @Post('lanes')
  upsertLane(@Body(new ZodValidationPipe(LaneBody)) b: LaneDto, @CurrentUser() u: JwtUser) {
    return this.svc.upsertLane(b, u);
  }

  @Delete('lanes/:id')
  deleteLane(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.svc.deleteLane(id, u);
  }

  // ── topology (assembled + validated) ──
  @Get('topology')
  topology(@CurrentUser() u: JwtUser) { return this.svc.topology(u); }

  // ── two-echelon plans (B2b, control SCM-05) ──
  @Post('plans/run')
  run(@Body(new ZodValidationPipe(RunBody)) b: z.infer<typeof RunBody>, @CurrentUser() u: JwtUser) {
    return this.runner.run(u, b.item_code);
  }

  @Get('plans')
  listPlans(@Query('status') status: string | undefined, @Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) {
    return this.plans.listPlans(u, { status, limit: limit ? Number(limit) : undefined });
  }

  @Get('plans/:id')
  getPlan(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.plans.getPlan(id, u);
  }

  @Post('plans/:id/submit')
  submitPlan(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.plans.submitPlan(id, u);
  }

  // Approve/reject require the APPROVER duty (scm_approve) — SoD R24 splits it from scm_plan.
  @Post('plans/:id/approve') @Permissions('scm_approve', 'exec')
  approvePlan(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ApproveBody)) b: z.infer<typeof ApproveBody>, @CurrentUser() u: JwtUser) {
    return this.plans.approvePlan(id, b, u);
  }

  @Post('plans/:id/reject') @Permissions('scm_approve', 'exec')
  rejectPlan(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(RejectBody)) b: z.infer<typeof RejectBody>, @CurrentUser() u: JwtUser) {
    return this.plans.rejectPlan(id, b, u);
  }

  @Post('plans/:id/convert')
  convertPlan(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: JwtUser) {
    return this.plans.convertPlan(id, u);
  }
}

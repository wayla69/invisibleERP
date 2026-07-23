import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Permissions, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { LaneBody, NodeBody, ScmNetworkService, type LaneDto, type NodeDto } from './scm-network.service';
import { ScmNetworkRunService } from './scm-network-run.service';
import { ScmNetworkPlanService, ApproveBody, RejectBody } from './scm-network-plan.service';
import {
  ScmAllocationService, PolicyBody, OverrideBody,
  ApproveBody as AllocApproveBody, RejectBody as AllocRejectBody,
} from './scm-allocation.service';

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
    private readonly alloc: ScmAllocationService,
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

  // ── DC-shortage allocation governance (B3, control SCM-06 / SoD R25) ──
  // Setting/overriding the policy is the `scm_allocate` maker duty; approving it is `scm_approve`.
  @Get('allocation/policies')
  listAllocPolicies(@Query('dc_node_code') dc: string | undefined, @Query('status') status: string | undefined, @CurrentUser() u: JwtUser) {
    return this.alloc.listPolicies(u, { dc_node_code: dc, status });
  }

  @Post('allocation/policies') @Permissions('scm_allocate', 'exec')
  setAllocPolicy(@Body(new ZodValidationPipe(PolicyBody)) b: z.infer<typeof PolicyBody>, @CurrentUser() u: JwtUser) {
    return this.alloc.setPolicy(u, b);
  }

  @Post('allocation/policies/:id/approve') @Permissions('scm_approve', 'exec')
  approveAllocPolicy(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(AllocApproveBody)) b: z.infer<typeof AllocApproveBody>, @CurrentUser() u: JwtUser) {
    return this.alloc.approvePolicy(id, b, u);
  }

  @Post('allocation/policies/:id/reject') @Permissions('scm_approve', 'exec')
  rejectAllocPolicy(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(AllocRejectBody)) b: z.infer<typeof AllocRejectBody>, @CurrentUser() u: JwtUser) {
    return this.alloc.rejectPolicy(id, b, u);
  }

  // A per-plan override — the maker proposes; an UNLOGGED one is rejected, a logged one staged for a
  // SECOND approver (never auto-applied).
  @Post('plans/:id/allocation-override') @Permissions('scm_allocate', 'exec')
  stageAllocOverride(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(OverrideBody)) b: z.infer<typeof OverrideBody>, @CurrentUser() u: JwtUser) {
    return this.alloc.stageOverride(id, b, u);
  }

  @Get('allocation/overrides')
  listAllocOverrides(@Query('plan_id') planId: string | undefined, @Query('status') status: string | undefined, @CurrentUser() u: JwtUser) {
    return this.alloc.listOverrides(u, { plan_id: planId ? Number(planId) : undefined, status });
  }

  @Post('allocation/overrides/:id/approve') @Permissions('scm_approve', 'exec')
  approveAllocOverride(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(AllocApproveBody)) b: z.infer<typeof AllocApproveBody>, @CurrentUser() u: JwtUser) {
    return this.alloc.approveOverride(id, b, u);
  }
}

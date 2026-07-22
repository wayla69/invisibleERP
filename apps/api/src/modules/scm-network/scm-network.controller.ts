import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { CurrentUser, Permissions, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { LaneBody, NodeBody, ScmNetworkService, type LaneDto, type NodeDto } from './scm-network.service';

// docs/57 Track B (B1) — supply-network master-data API.
//
// Topology is GOVERNED master data: gated by the PLANNER duty (`scm_plan`), same as the demand
// planning surface. B1 is definition only — CRUD + a validated topology view. The two-echelon
// optimizer and its maker-checker (SCM-05) arrive in B2 on this same module.

@Controller('api/scm-network')
@Permissions('scm_plan', 'exec')
export class ScmNetworkController {
  constructor(private readonly svc: ScmNetworkService) {}

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
}

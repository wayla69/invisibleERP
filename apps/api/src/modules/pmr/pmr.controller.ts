import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { PmrService, type PmrSubmitDto } from './pmr.service';

const SubmitBody = z.object({
  project_code: z.string().min(1),
  vendor_name: z.string().optional(),
  items: z.array(z.object({
    boq_line_id: z.number().int().positive(),
    item_no: z.string().optional(),
    qty: z.number().positive(),
    unit_cost: z.number().nonnegative(),
  })).min(1),
});
const RejectBody = z.object({ reason: z.string().optional() });

// Project Material Requisition (PMR) — M2, docs/32, PROJ-13. Staff draw material against a project's BoQ;
// within budget it routes to a project-tagged PR, over budget it parks pending an authoriser (maker-checker +
// one-tap LINE approval) whose approval auto-drafts a project-tagged PO.
@Controller('api/pmr')
export class PmrController {
  constructor(private readonly svc: PmrService) {}

  // Raise a requisition (any requisition-raiser). Static 'project/:code' segment below never collides.
  @Post()
  @Permissions('pr_raise', 'procurement', 'planner')
  submit(@Body(new ZodValidationPipe(SubmitBody)) b: PmrSubmitDto, @CurrentUser() u: JwtUser) {
    return this.svc.submit(b, u);
  }

  // Shop-for-a-project reads (pr_raise-safe): the projects a requester may shop into, and a project's
  // approved BoQ material lines with remaining budget. Static segments — never collide with :pmrNo below.
  @Get('projects')
  @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  shoppableProjects(@CurrentUser() u: JwtUser) {
    return this.svc.shoppableProjects();
  }

  @Get('project/:code/boq')
  @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  shoppableBoq(@Param('code') code: string, @CurrentUser() u: JwtUser) {
    return this.svc.shoppableBoq(code);
  }

  @Get('project/:code')
  @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  listForProject(@Param('code') code: string, @CurrentUser() u: JwtUser) {
    return this.svc.listForProject(code);
  }

  @Get(':pmrNo')
  @Permissions('pr_raise', 'procurement', 'planner', 'exec')
  get(@Param('pmrNo') pmrNo: string) {
    return this.svc.get(pmrNo);
  }

  // Approve / reject an over-budget PMR (authoriser ≠ requester, maker-checker).
  @Post(':pmrNo/approve')
  @Permissions('procurement', 'exec')
  approve(@Param('pmrNo') pmrNo: string, @CurrentUser() u: JwtUser) {
    return this.svc.approve(pmrNo, u);
  }

  @Post(':pmrNo/reject')
  @Permissions('procurement', 'exec')
  reject(@Param('pmrNo') pmrNo: string, @Body(new ZodValidationPipe(RejectBody)) b: { reason?: string }, @CurrentUser() u: JwtUser) {
    return this.svc.reject(pmrNo, b.reason ?? '', u);
  }
}

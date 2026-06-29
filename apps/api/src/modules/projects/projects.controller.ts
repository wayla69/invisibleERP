import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ProjectsService, type CreateProjectDto, type CostDto, type BillDto, type FromOpportunityDto, type TaskDto, type TaskPatchDto, type MilestoneDto, type RateCardDto, type ResourceDto } from './projects.service';

const CreateBody = z.object({
  name: z.string().min(1),
  project_code: z.string().optional(),
  customer_name: z.string().optional(),
  customer_no: z.string().optional(),
  billing_type: z.enum(['TM', 'Fixed']).optional(),
  budget_amount: z.number().nonnegative().optional(),
  contract_amount: z.number().nonnegative().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});
const FromOppBody = z.object({
  project_code: z.string().optional(),
  billing_type: z.enum(['TM', 'Fixed']).optional(),
  budget_amount: z.number().nonnegative().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});
const CostBody = z.object({
  entry_type: z.enum(['time', 'expense']).optional(),
  description: z.string().optional(),
  qty: z.number().optional(),
  rate: z.number().optional(),
  amount: z.number().optional(),
  billable: z.boolean().optional(),
  entry_date: z.string().optional(),
});
const BillBody = z.object({ amount: z.number().positive().optional(), percent: z.number().positive().max(100).optional() })
  .refine((b) => b.amount != null || b.percent != null, { message: 'amount or percent is required' });
const TaskBody = z.object({
  name: z.string().min(1),
  parent_id: z.number().int().positive().optional(),
  wbs_code: z.string().optional(),
  status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(),
  planned_start: z.string().optional(),
  planned_end: z.string().optional(),
  planned_hours: z.number().nonnegative().optional(),
  planned_cost: z.number().nonnegative().optional(),
  pct_complete: z.number().min(0).max(100).optional(),
  assignee: z.string().optional(),
  depends_on: z.array(z.number().int().positive()).optional(),
});
const TaskPatchBody = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(),
  planned_start: z.string().optional(),
  planned_end: z.string().optional(),
  planned_hours: z.number().nonnegative().optional(),
  planned_cost: z.number().nonnegative().optional(),
  pct_complete: z.number().min(0).max(100).optional(),
  assignee: z.string().optional(),
  depends_on: z.array(z.number().int().positive()).optional(),
});
const MilestoneBody = z.object({
  name: z.string().min(1),
  due_date: z.string().optional(),
  owner: z.string().optional(),
  billing_percent: z.number().positive().max(100).optional(),
});
const RateCardBody = z.object({
  role: z.string().min(1),
  cost_rate: z.number().nonnegative().optional(),
  bill_rate: z.number().nonnegative().optional(),
  effective_from: z.string().optional(),
  effective_to: z.string().optional(),
});
const ResourceBody = z.object({
  resource_name: z.string().min(1),
  role: z.string().optional(),
  task_id: z.number().int().positive().optional(),
  alloc_pct: z.number().min(0).max(100).optional(),
  period_start: z.string().optional(),
  period_end: z.string().optional(),
});

@Controller('api/projects')
@Permissions('exec', 'planner', 'ar')
export class ProjectsController {
  constructor(private readonly svc: ProjectsService) {}

  @Post()
  create(@Body(new ZodValidationPipe(CreateBody)) b: CreateProjectDto, @CurrentUser() u: JwtUser) {
    return this.svc.create(b, u);
  }

  // Convert a won CRM opportunity into a project (CRM-WL). Static segment, so it never collides with :code.
  @Post('from-opportunity/:oppNo')
  fromOpportunity(@Param('oppNo') oppNo: string, @Body(new ZodValidationPipe(FromOppBody)) b: FromOpportunityDto, @CurrentUser() u: JwtUser) {
    return this.svc.createFromOpportunity(oppNo, b, u);
  }

  @Get()
  list(@CurrentUser() u: JwtUser) {
    return this.svc.list(u);
  }

  @Get(':code')
  get(@Param('code') code: string) {
    return this.svc.get(code);
  }

  // Earned-value metrics (P4): BAC/PV/EV/AC → CPI/SPI + variances + EAC. Static 'evm' segment.
  @Get(':code/evm')
  evm(@Param('code') code: string, @Query('as_of') asOf: string | undefined) {
    return this.svc.evm(code, asOf);
  }

  @Post(':code/cost')
  cost(@Param('code') code: string, @Body(new ZodValidationPipe(CostBody)) b: CostDto, @CurrentUser() u: JwtUser) {
    return this.svc.logCost(code, b, u);
  }

  @Post(':code/bill')
  bill(@Param('code') code: string, @Body(new ZodValidationPipe(BillBody)) b: BillDto, @CurrentUser() u: JwtUser) {
    return this.svc.bill(code, b, u);
  }

  // ── WBS tasks (P1) ──
  @Post(':code/tasks')
  addTask(@Param('code') code: string, @Body(new ZodValidationPipe(TaskBody)) b: TaskDto, @CurrentUser() u: JwtUser) {
    return this.svc.addTask(code, b, u);
  }

  @Get(':code/tasks')
  listTasks(@Param('code') code: string) {
    return this.svc.listTasks(code);
  }

  // Static 'tasks' segment, so it never collides with :code.
  @Patch('tasks/:taskId')
  patchTask(@Param('taskId') taskId: string, @Body(new ZodValidationPipe(TaskPatchBody)) b: TaskPatchDto, @CurrentUser() u: JwtUser) {
    return this.svc.patchTask(Number(taskId), b, u);
  }

  // ── Milestones (P1) ──
  @Post(':code/milestones')
  addMilestone(@Param('code') code: string, @Body(new ZodValidationPipe(MilestoneBody)) b: MilestoneDto, @CurrentUser() u: JwtUser) {
    return this.svc.addMilestone(code, b, u);
  }

  @Get(':code/milestones')
  listMilestones(@Param('code') code: string) {
    return this.svc.listMilestones(code);
  }

  // Static 'milestones' segment, so it never collides with :code.
  @Post('milestones/:milestoneId/reach')
  reachMilestone(@Param('milestoneId') milestoneId: string, @CurrentUser() u: JwtUser) {
    return this.svc.reachMilestone(Number(milestoneId), u);
  }

  // ── Resource rate card + assignments (P2) ── static 'rate-cards'/'resources' segments don't collide with :code.
  @Post('rate-cards')
  addRateCard(@Body(new ZodValidationPipe(RateCardBody)) b: RateCardDto, @CurrentUser() u: JwtUser) {
    return this.svc.addRateCard(b, u);
  }

  @Get('rate-cards')
  listRateCards(@CurrentUser() u: JwtUser) {
    return this.svc.listRateCards(u);
  }

  @Get('resources/utilization')
  utilization(@CurrentUser() u: JwtUser) {
    return this.svc.resourceUtilization(u);
  }

  @Post(':code/resources')
  assignResource(@Param('code') code: string, @Body(new ZodValidationPipe(ResourceBody)) b: ResourceDto, @CurrentUser() u: JwtUser) {
    return this.svc.assignResource(code, b, u);
  }

  @Get(':code/resources')
  listResources(@Param('code') code: string) {
    return this.svc.listResources(code);
  }
}

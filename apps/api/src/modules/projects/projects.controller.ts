import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { ProjectsService, type CreateProjectDto, type CostDto, type BillDto, type FromOpportunityDto, type TaskDto, type TaskPatchDto, type MilestoneDto, type RateCardDto, type ResourceDto, type ResourceSkillDto, type ResourceCalendarDto, type BaselineDto, type TemplateDto, type ApplyTemplateDto, type RiskDto, type RiskPatchDto, type RecognizeDto, type ChangeOrderDto, type ProgramDto, type BoqDto, type BoqLineDto, type RemeasureDto } from './projects.service';

// BoQ (M0, docs/32) — line: amount is budget_qty × rate unless an explicit budget_amount is given.
const BoqLineBody = z.object({
  category: z.enum(['material', 'labor', 'subcon', 'other']).optional(),
  item_no: z.string().optional(),
  task_id: z.number().int().positive().optional(),
  wbs_code: z.string().optional(),
  description: z.string().optional(),
  uom: z.string().optional(),
  budget_qty: z.number().nonnegative().optional(),
  rate: z.number().nonnegative().optional(),
  budget_amount: z.number().nonnegative().optional(),
});
const BoqBody = z.object({ title: z.string().optional(), boq_no: z.string().optional(), lines: z.array(BoqLineBody).optional() });
const RemeasureBody = z.object({ remeasured_qty: z.number().nonnegative() });

const CreateBody = z.object({
  name: z.string().min(1),
  project_code: z.string().optional(),
  customer_name: z.string().optional(),
  customer_no: z.string().optional(),
  billing_type: z.enum(['TM', 'Fixed']).optional(),
  budget_amount: z.number().nonnegative().optional(),
  budget_tolerance_pct: z.number().nonnegative().max(100).optional(),
  contract_amount: z.number().nonnegative().optional(),
  rev_method: z.enum(['billing', 'poc']).optional(),
  estimated_cost: z.number().nonnegative().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});
const RecognizeBody = z.object({ as_of: z.string().optional(), estimated_cost: z.number().positive().optional() });
const ChangeOrderBody = z.object({
  description: z.string().optional(),
  contract_delta: z.number().optional(),
  budget_delta: z.number().optional(),
  estimated_cost_delta: z.number().optional(),
  reason: z.string().optional(),
});
const FromOppBody = z.object({
  project_code: z.string().optional(),
  billing_type: z.enum(['TM', 'Fixed']).optional(),
  budget_amount: z.number().nonnegative().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});
const ProgramBody = z.object({
  program_code: z.string().nullable().optional(),
  depends_on_projects: z.array(z.string()).optional(),
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
  accountable: z.string().optional(),
  responsible: z.array(z.string()).optional(),
  consulted: z.array(z.string()).optional(),
  informed: z.array(z.string()).optional(),
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
  accountable: z.string().optional(),
  responsible: z.array(z.string()).optional(),
  consulted: z.array(z.string()).optional(),
  informed: z.array(z.string()).optional(),
});
const MilestoneBody = z.object({
  name: z.string().min(1),
  due_date: z.string().optional(),
  owner: z.string().optional(),
  billing_percent: z.number().positive().max(100).optional(),
});
const BaselineBody = z.object({ label: z.string().optional(), reason: z.string().optional() });
const TemplateItemBody = z.object({
  item_type: z.enum(['task', 'milestone']).optional(),
  seq: z.number().int().positive().optional(),
  name: z.string().min(1),
  parent_seq: z.number().int().positive().optional(),
  wbs_code: z.string().optional(),
  planned_hours: z.number().nonnegative().optional(),
  planned_cost: z.number().nonnegative().optional(),
  offset_start_days: z.number().int().min(0).optional(),
  offset_end_days: z.number().int().min(0).optional(),
  depends_on_seq: z.array(z.number().int().positive()).optional(),
  billing_percent: z.number().positive().max(100).optional(),
  owner: z.string().optional(),
  assignee: z.string().optional(),
});
const TemplateBody = z.object({
  code: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  items: z.array(TemplateItemBody).optional(),
});
const ApplyTemplateBody = z.object({ start_date: z.string().optional() });
const RiskBody = z.object({
  kind: z.enum(['risk', 'issue']).optional(),
  title: z.string().min(1),
  probability: z.number().int().min(1).max(5).optional(),
  impact: z.number().int().min(1).max(5).optional(),
  owner: z.string().optional(),
  mitigation: z.string().optional(),
  due_date: z.string().optional(),
});
const RiskPatchBody = z.object({
  status: z.enum(['open', 'mitigating', 'closed']).optional(),
  probability: z.number().int().min(1).max(5).optional(),
  impact: z.number().int().min(1).max(5).optional(),
  owner: z.string().optional(),
  mitigation: z.string().optional(),
  due_date: z.string().optional(),
  title: z.string().min(1).optional(),
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
// PPM-A1 (PROJ-20): named-vs-generic skill/role tagging + per-resource availability calendar.
const ResourceSkillBody = z.object({
  resource_name: z.string().min(1),
  skill: z.string().min(1),
  proficiency: z.string().optional(),
});
// month/available_pct format+range are business-rule checked in the service (BAD_MONTH/BAD_AVAILABLE_PCT with
// a Thai message) rather than shadowed here by a stricter Zod constraint.
const ResourceCalendarBody = z.object({
  resource_name: z.string().min(1),
  month: z.string().min(1),
  available_pct: z.number().optional(),
  reason: z.string().optional(),
});

@Controller('api/projects')
@Permissions('exec', 'planner', 'ar')
@RequiresSuite('projects')
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

  // Portfolio command center (A1): cross-project EVM rollup, health, financials, capacity, pipeline funnel.
  // Static 'portfolio' segment, so it never collides with :code.
  @Get('portfolio')
  portfolio(@CurrentUser() u: JwtUser) {
    return this.svc.portfolioEvm(u);
  }

  // Action center / exception inbox (PMO-1, PROJ-11): the single "what needs me now" worklist across all the
  // caller's projects. Static segment, declared before :code so it never collides. ?stale_days overrides the
  // health-staleness window (default 14).
  @Get('action-center')
  actionCenter(@Query('stale_days') staleDays: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.actionCenter(u, { stale_days: staleDays != null ? Number(staleDays) : undefined });
  }

  // Forward resource & cash forecast (PMO-2): committed capacity demand + a billings/cash forecast overlaying
  // committed contractual billing with the probability-weighted pipeline. Static segment, before :code.
  @Get('forecast')
  forecast(@Query('months') months: string | undefined, @Query('from') from: string | undefined, @Query('rev_per_fte_month') revPerFte: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.forecast(u, { months: months != null ? Number(months) : undefined, from, rev_per_fte_month: revPerFte != null ? Number(revPerFte) : undefined });
  }

  // Period governance / status pack (PMO-3): the portfolio status roll-up. Static segment, before :code.
  @Get('governance-pack')
  governancePack(@Query('period') period: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.governancePack(u, { period });
  }

  // Program (cross-project) critical path (PMO-4). Static segments, declared before :code so they never collide.
  @Get('programs')
  programs(@CurrentUser() u: JwtUser) {
    return this.svc.programs(u);
  }

  @Get('program-critical-path')
  programCriticalPath(@Query('program') program: string, @CurrentUser() u: JwtUser) {
    return this.svc.programCriticalPath(program, u);
  }

  // ── Project templates (B2) ── static 'templates' segment, declared before :code so it never collides.
  @Post('templates')
  createTemplate(@Body(new ZodValidationPipe(TemplateBody)) b: TemplateDto, @CurrentUser() u: JwtUser) {
    return this.svc.createTemplate(b, u);
  }

  @Get('templates')
  listTemplates(@CurrentUser() u: JwtUser) {
    return this.svc.listTemplates(u);
  }

  @Get('templates/:tpl')
  getTemplate(@Param('tpl') tpl: string) {
    return this.svc.getTemplate(tpl);
  }

  // "My tasks" (B3): the caller's open tasks across projects (accountable/responsible). Static segment.
  @Get('my-tasks')
  myTasks(@CurrentUser() u: JwtUser) {
    return this.svc.myTasks(u);
  }

  // Portfolio top-risks roll-up (B4, PROJ-08): open risks/issues across projects, ranked. Static segment.
  @Get('risks/top')
  topRisks(@CurrentUser() u: JwtUser) {
    return this.svc.topRisks(u);
  }

  // Update a risk/issue (status/score/mitigation). Static 'risks' segment, so it never collides with :code.
  @Patch('risks/:riskId')
  patchRisk(@Param('riskId') riskId: string, @Body(new ZodValidationPipe(RiskPatchBody)) b: RiskPatchDto, @CurrentUser() u: JwtUser) {
    return this.svc.patchRisk(Number(riskId), b, u);
  }

  // ── Bill of Quantities (BoQ) — M0, docs/32 ── static 'boq' segments (≥2 path parts) never collide with :code.
  @Post('boq/:boqId/lines')
  addBoqLine(@Param('boqId') boqId: string, @Body(new ZodValidationPipe(BoqLineBody)) b: BoqLineDto, @CurrentUser() u: JwtUser) {
    return this.svc.addBoqLine(Number(boqId), b, u);
  }

  // Approve a BoQ (maker-checker: approver ≠ author). Syncs the project budget to the approved BoQ total.
  @Post('boq/:boqId/approve')
  approveBoq(@Param('boqId') boqId: string, @CurrentUser() u: JwtUser) {
    return this.svc.approveBoq(Number(boqId), u);
  }

  @Post('boq/:boqId/lock')
  lockBoq(@Param('boqId') boqId: string, @CurrentUser() u: JwtUser) {
    return this.svc.lockBoq(Number(boqId), u);
  }

  // Re-measurement — record the actual measured qty on a line. Static 'boq/lines' segment, before :code.
  @Post('boq/lines/:lineId/remeasure')
  remeasureBoqLine(@Param('lineId') lineId: string, @Body(new ZodValidationPipe(RemeasureBody)) b: RemeasureDto, @CurrentUser() u: JwtUser) {
    return this.svc.remeasureBoqLine(Number(lineId), b, u);
  }

  @Get(':code')
  get(@Param('code') code: string) {
    return this.svc.get(code);
  }

  // Create / read a project's BoQ (M0, docs/32).
  @Post(':code/boq')
  createBoq(@Param('code') code: string, @Body(new ZodValidationPipe(BoqBody)) b: BoqDto, @CurrentUser() u: JwtUser) {
    return this.svc.createBoq(code, b, u);
  }

  @Get(':code/boq')
  getBoq(@Param('code') code: string) {
    return this.svc.getBoq(code);
  }

  // Commitment / encumbrance ledger for a project (M1, PROJ-12): open/consumed/released draws vs the BoQ budget.
  @Get(':code/commitments')
  commitments(@Param('code') code: string) {
    return this.svc.listCommitments(code);
  }

  // Site cash (M4, PROJ-14): advances + expense reimbursements + petty-cash raised against this project.
  @Get(':code/site-cash')
  siteCash(@Param('code') code: string) {
    return this.svc.siteCash(code);
  }

  // RACI accountability matrix (B3): per-task A/R/C/I + per-person rollup + accountability gaps.
  @Get(':code/raci')
  raci(@Param('code') code: string) {
    return this.svc.raci(code);
  }

  // Apply a template to a project → scaffold its standard WBS + milestones in one step.
  @Post(':code/apply-template/:tpl')
  applyTemplate(@Param('code') code: string, @Param('tpl') tpl: string, @Body(new ZodValidationPipe(ApplyTemplateBody)) b: ApplyTemplateDto, @CurrentUser() u: JwtUser) {
    return this.svc.applyTemplate(code, tpl, b, u);
  }

  // Earned-value metrics (P4): BAC/PV/EV/AC → CPI/SPI + variances + EAC. Static 'evm' segment.
  @Get(':code/evm')
  evm(@Param('code') code: string, @Query('as_of') asOf: string | undefined) {
    return this.svc.evm(code, asOf);
  }

  // EVM S-curve series (planned cumulative cost by month + current EV/AC/PV overlay).
  @Get(':code/evm/series')
  evmSeries(@Param('code') code: string, @Query('months') months: string | undefined) {
    return this.svc.evmSeries(code, { months: months ? Number(months) : undefined });
  }

  // Earned Schedule (PROJ-19): time-based schedule performance off the PV curve — ES / SV(t) / SPI(t) stay
  // honest to completion where the classic SPI converges to 1 (PV saturates at BAC on a late project).
  @Get(':code/earned-schedule')
  earnedSchedule(@Param('code') code: string, @Query('as_of') asOf: string | undefined) {
    return this.svc.earnedSchedule(code, asOf);
  }

  // Project health history (PPM upgrade): capture a dated EVM/RAG snapshot; read the trajectory.
  @Post(':code/health')
  captureHealth(@Param('code') code: string, @Body() b: { as_of?: string }, @CurrentUser() u: JwtUser) {
    return this.svc.captureHealth(code, b ?? {}, u);
  }

  @Get(':code/health')
  healthHistory(@Param('code') code: string) {
    return this.svc.healthHistory(code);
  }

  // Period governance / status pack (PMO-3): the full per-project status report (EVM + health trend +
  // baseline variance + open-high risks + milestones + change-order log).
  @Get(':code/governance-pack')
  projectGovernancePack(@Param('code') code: string, @Query('period') period: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.governancePack(u, { code, period });
  }

  // Program grouping + cross-project dependencies (PMO-4): set this project's program and the projects it
  // must follow (finish-to-start) for the program critical path.
  @Patch(':code/program')
  setProgram(@Param('code') code: string, @Body(new ZodValidationPipe(ProgramBody)) b: ProgramDto, @CurrentUser() u: JwtUser) {
    return this.svc.setProgram(code, b, u);
  }

  // Critical-path schedule (CPM): per-task ES/EF/LS/LF, slack, and on_critical_path for the Gantt.
  @Get(':code/schedule')
  schedule(@Param('code') code: string) {
    return this.svc.schedule(code);
  }

  // Baselines (B1, PROJ-07): capture a change-controlled baseline; read the active baseline + variance.
  @Post(':code/baseline')
  captureBaseline(@Param('code') code: string, @Body(new ZodValidationPipe(BaselineBody)) b: BaselineDto, @CurrentUser() u: JwtUser) {
    return this.svc.captureBaseline(code, b, u);
  }

  @Get(':code/baseline')
  getBaseline(@Param('code') code: string, @CurrentUser() u: JwtUser) {
    return this.svc.getBaseline(code, u);
  }

  // ── Change orders / contract variations (PROJ-10) ── maker-checker amendment to contract/budget/EAC.
  @Post(':code/change-orders')
  createChangeOrder(@Param('code') code: string, @Body(new ZodValidationPipe(ChangeOrderBody)) b: ChangeOrderDto, @CurrentUser() u: JwtUser) {
    return this.svc.createChangeOrder(code, b, u);
  }

  @Get(':code/change-orders')
  listChangeOrders(@Param('code') code: string) {
    return this.svc.listChangeOrders(code);
  }

  // Approve / reject — static 'change-orders' segment, so it never collides with :code. Approver ≠ requester.
  @Post('change-orders/:coId/approve')
  approveChangeOrder(@Param('coId') coId: string, @CurrentUser() u: JwtUser) {
    return this.svc.approveChangeOrder(Number(coId), u);
  }

  @Post('change-orders/:coId/reject')
  rejectChangeOrder(@Param('coId') coId: string, @CurrentUser() u: JwtUser) {
    return this.svc.rejectChangeOrder(Number(coId), u);
  }

  // ── Risk & issue register (B4, PROJ-08) ──
  @Post(':code/risks')
  addRisk(@Param('code') code: string, @Body(new ZodValidationPipe(RiskBody)) b: RiskDto, @CurrentUser() u: JwtUser) {
    return this.svc.addRisk(code, b, u);
  }

  @Get(':code/risks')
  listRisks(@Param('code') code: string) {
    return this.svc.listRisks(code);
  }

  @Post(':code/cost')
  cost(@Param('code') code: string, @Body(new ZodValidationPipe(CostBody)) b: CostDto, @CurrentUser() u: JwtUser) {
    return this.svc.logCost(code, b, u);
  }

  @Post(':code/bill')
  bill(@Param('code') code: string, @Body(new ZodValidationPipe(BillBody)) b: BillDto, @CurrentUser() u: JwtUser) {
    return this.svc.bill(code, b, u);
  }

  // Over-time (percentage-of-completion) revenue recognition for a POC project (PROJ-09). Authorized.
  @Post(':code/recognize')
  @Permissions('gl_post', 'exec')
  recognize(@Param('code') code: string, @Body(new ZodValidationPipe(RecognizeBody)) b: RecognizeDto, @CurrentUser() u: JwtUser) {
    return this.svc.recognizePoc(code, b, u);
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

  // Time-phased capacity calendar (PPM upgrade): per-resource demand-vs-capacity by month. Static segment.
  @Get('resources/capacity')
  capacity(@Query('months') months: string | undefined, @Query('from') from: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.resourceCapacity(u, { months: months ? Number(months) : undefined, from });
  }

  // PPM-A1 (PROJ-20): which real, NAMED people can fill a role/skill — the supply side of role/skill
  // supply-vs-demand, and the named-vs-generic flag on the capacity heatmap. Static segment.
  @Post('resources/skills')
  upsertResourceSkill(@Body(new ZodValidationPipe(ResourceSkillBody)) b: ResourceSkillDto, @CurrentUser() u: JwtUser) {
    return this.svc.upsertResourceSkill(b, u);
  }

  @Get('resources/skills')
  listResourceSkills(@CurrentUser() u: JwtUser) {
    return this.svc.listResourceSkills(u);
  }

  // PPM-A1 (PROJ-20): per-resource, per-month availability override (PTO/part-time) — the real capacity
  // ceiling behind the heatmap's over-allocation flag (default 100% absent an override). Static segment.
  @Post('resources/calendar')
  upsertResourceCalendar(@Body(new ZodValidationPipe(ResourceCalendarBody)) b: ResourceCalendarDto, @CurrentUser() u: JwtUser) {
    return this.svc.upsertResourceCalendar(b, u);
  }

  @Get('resources/calendar')
  listResourceCalendar(@Query('resource_name') resourceName: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listResourceCalendar(u, resourceName);
  }

  // PPM-A1 (PROJ-20): role/skill supply-vs-demand — per role, per month, qualified-people supply vs assigned
  // demand; understaffed when supply < demand. Static segment.
  @Get('resources/role-demand')
  roleDemand(@Query('months') months: string | undefined, @Query('from') from: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.roleSupplyDemand(u, { months: months ? Number(months) : undefined, from });
  }

  @Post(':code/resources')
  assignResource(@Param('code') code: string, @Body(new ZodValidationPipe(ResourceBody)) b: ResourceDto, @CurrentUser() u: JwtUser) {
    return this.svc.assignResource(code, b, u);
  }

  @Get(':code/resources')
  listResources(@Param('code') code: string) {
    return this.svc.listResources(code);
  }

  // PROJ-03 — period-end WIP/clearing close review + maker-checker sign-off (controller/finance: 'exec').
  @Post('close-review') @Permissions('exec')
  prepareCloseReview(@Query('period') period: string, @CurrentUser() u: JwtUser) { return this.svc.prepareCloseReview(period, u); }

  @Post('close-review/:period/approve') @Permissions('exec')
  approveCloseReview(@Param('period') period: string, @CurrentUser() u: JwtUser) { return this.svc.approveCloseReview(period, u); }

  @Post('close-review/:period/reject') @Permissions('exec')
  rejectCloseReview(@Param('period') period: string, @Body(new ZodValidationPipe(z.object({ reason: z.string().optional() }))) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.rejectCloseReview(period, b.reason ?? '', u); }

  @Get('close-review/:period') @Permissions('exec')
  getCloseReview(@Param('period') period: string, @CurrentUser() u: JwtUser) { return this.svc.getCloseReview(period, u); }

  @Get('close-reviews') @Permissions('exec')
  listCloseReviews(@CurrentUser() u: JwtUser) { return this.svc.listCloseReviews(u); }
}

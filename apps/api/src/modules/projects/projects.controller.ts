import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { ProjectsService, type CreateProjectDto, type CostDto, type BillDto, type FromOpportunityDto, type TaskDto, type TaskPatchDto, type TaskDependencyDto, type MilestoneDto, type ResourceDto, type BaselineDto, type EtcDto, type TemplateDto, type ApplyTemplateDto, type RiskDto, type RiskPatchDto, type RecognizeDto, type ChangeOrderDto, type ProgramDto, type BoqDto, type BoqLineDto, type RemeasureDto } from './projects.service';

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
const BoqImportBody = z.object({
  format: z.enum(['rows', 'csv', 'xlsx']).optional(),
  csv: z.string().max(2_000_000).optional(),
  xlsx: z.string().max(8_000_000).optional(),
  rows: z.array(z.record(z.any())).max(2000).optional(),
  boq_no: z.string().max(40).optional(),
  title: z.string().max(200).optional(),
});
type BoqImportBodyT = z.infer<typeof BoqImportBody>;
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
// PPM-B1 (PROJ-21): a richer predecessor list — dep_type (default FS) + lag/lead in days. Omit and pass plain
// `depends_on` for the unchanged FS/lag-0 behaviour.
const TaskDependencyBody = z.object({
  task_id: z.number().int().positive(),
  type: z.enum(['FS', 'SS', 'FF', 'SF']).optional(),
  lag_days: z.number().int().optional(),
});
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
  dependencies: z.array(TaskDependencyBody).optional(),
  constraint_type: z.enum(['SNET', 'FNLT']).nullable().optional(),
  constraint_offset_days: z.number().int().nullable().optional(),
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
  dependencies: z.array(TaskDependencyBody).optional(),
  constraint_type: z.enum(['SNET', 'FNLT']).nullable().optional(),
  constraint_offset_days: z.number().int().nullable().optional(),
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
// PPM-B2 (PROJ-22): non-negative-amount format is Zod-checked here; TASK_NOT_FOUND (a task_id that isn't on
// this project) is a genuine business-rule check that stays in the service.
const EtcBody = z.object({
  task_id: z.number().int().positive().optional(),
  etc_amount: z.number().nonnegative(),
  note: z.string().optional(),
});
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
  approveBoq(@Param('boqId') boqId: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.approveBoq(Number(boqId), u, b?.self_approval_reason);
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

  // A3 (docs/50 Wave 3) — material control tower reads: WBS rollup + planned-vs-actual draw curve.
  @Get(':code/boq/by-wbs')
  boqByWbs(@Param('code') code: string) {
    return this.svc.boqByWbs(code);
  }

  @Get(':code/material-draw')
  materialDrawCurve(@Param('code') code: string) {
    return this.svc.materialDrawCurve(code);
  }

  // A4 (docs/50 Wave 4) — BoQ takeoff import: csv / rows / base64 xlsx → DRAFT lines (fail-closed,
  // all-or-nothing; PROJ-12 approval unchanged). Static 'boq/import-template' never collides with :code.
  @Get('boq/import-template')
  boqImportTemplate() {
    return this.svc.boqImportTemplate();
  }

  @Post(':code/boq/import')
  importBoq(@Param('code') code: string, @Body(new ZodValidationPipe(BoqImportBody)) b: BoqImportBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.importBoq(code, b, u);
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

  // A5 (docs/50 Wave 5) — EVM split by BoQ category (material/labor/subcon/other) incl. material CPI + wasted.
  @Get(':code/evm/by-category')
  evmByCategory(@Param('code') code: string) {
    return this.svc.evmByCategory(code);
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

  // PPM-B2 (PROJ-22): manual bottom-up ETC entry (per task, or project-level when task_id is omitted) + the
  // EAC-scenario comparison (formulaic evm() EAC vs the bottom-up figure).
  @Post(':code/etc')
  submitEtc(@Param('code') code: string, @Body(new ZodValidationPipe(EtcBody)) b: EtcDto, @CurrentUser() u: JwtUser) {
    return this.svc.submitEtc(code, b, u);
  }

  @Get(':code/eac-scenarios')
  eacScenarios(@Param('code') code: string) {
    return this.svc.eacScenarios(code);
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
  approveChangeOrder(@Param('coId') coId: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) {
    return this.svc.approveChangeOrder(Number(coId), u, b?.self_approval_reason);
  }

  @Post('change-orders/:coId/reject')
  rejectChangeOrder(@Param('coId') coId: string, @CurrentUser() u: JwtUser) {
    return this.svc.rejectChangeOrder(Number(coId), u);
  }

  // PROJ-24: read-only what-if — the projected cost/margin/EVM impact of a pending change order before it is
  // authorised. Mutates nothing; inherits the class gate (exec/planner/ar).
  @Get('change-orders/:coId/simulate')
  simulateChangeOrder(@Param('coId') coId: string) {
    return this.svc.simulateChangeOrder(Number(coId));
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

  @Post(':code/resources')
  assignResource(@Param('code') code: string, @Body(new ZodValidationPipe(ResourceBody)) b: ResourceDto, @CurrentUser() u: JwtUser) {
    return this.svc.assignResource(code, b, u);
  }

  @Get(':code/resources')
  listResources(@Param('code') code: string) {
    return this.svc.listResources(code);
  }

}

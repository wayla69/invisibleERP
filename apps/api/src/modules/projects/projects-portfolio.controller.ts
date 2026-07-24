// Portfolio / PMO / governance / resourcing route surface for `api/projects` (docs/46 god-service
// burn-down round 5). Split out of projects.controller.ts VERBATIM — same route prefix, same class gates
// (exec/planner/ar + the projects suite), identical paths and pipes, so the API contract is unchanged.
// Fastify's router gives static segments precedence over `:code` params regardless of controller
// registration order, so the split is routing-safe. Owns: the PMO command-center reads (portfolio /
// action-center / forecast / governance-pack / programs), portfolio selection scenarios (PROJ-25),
// phase gates (PROJ-26), program benefits (PROJ-27), the period close review (PROJ-03), the working
// calendar (PROJ-21), and resourcing/rate cards/skills (PROJ-05/PROJ-20).
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import { ProjectsService, type RateCardDto, type ResourceSkillDto, type ResourceCalendarDto, type ProjectCalendarDto, type CalendarExceptionDto, type PortfolioScenarioDto, type PortfolioItemDto, type PortfolioCommitDto, type PhaseGateDto, type GateDecisionDto, type BenefitDto, type BenefitMeasurementDto, type BenefitConfirmDto } from './projects.service';

// PPM-B1 (PROJ-21): opt-in per-tenant working calendar.
const CalendarBody = z.object({
  enabled: z.boolean().optional(),
  non_working_weekdays: z.array(z.number().int().min(0).max(6)).optional(),
});
const CalendarExceptionBody = z.object({
  exception_date: z.string().min(1),
  description: z.string().optional(),
});
const RateCardBody = z.object({
  role: z.string().min(1),
  cost_rate: z.number().nonnegative().optional(),
  bill_rate: z.number().nonnegative().optional(),
  effective_from: z.string().optional(),
  effective_to: z.string().optional(),
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
// PROJ-25 portfolio selection scenarios (PPM Wave P4)
const PortfolioScenarioBody = z.object({
  name: z.string().min(1),
  budget_envelope: z.number().nonnegative().optional(),
  objective: z.string().optional(),
  notes: z.string().optional(),
});
const PortfolioItemBody = z.object({
  project_code: z.string().min(1),
  decision: z.enum(['include', 'exclude']).optional(),
  priority_score: z.number().nonnegative().optional(),
  rationale: z.string().optional(),
});
const PortfolioCommitBody = z.object({ override: z.boolean().optional(), override_reason: z.string().optional(), self_approval_reason: z.string().max(500).optional() });
// PROJ-26 project phase-gate governance (PPM Wave P4)
const PhaseGateBody = z.object({ target_phase: z.string().min(1), gate_key: z.string().optional(), name: z.string().optional(), readiness: z.string().optional() });
const GateDecisionBody = z.object({ decision: z.enum(['go', 'hold', 'kill']), notes: z.string().optional(), self_approval_reason: z.string().max(500).optional() });
// PROJ-27 program benefits realization (PPM Wave P4)
const BenefitBody = z.object({ name: z.string().min(1), category: z.enum(['financial', 'non_financial']).optional(), unit: z.string().optional(), baseline_value: z.number().optional(), target_value: z.number(), target_date: z.string().optional(), owner: z.string().optional() });
const BenefitMeasurementBody = z.object({ measured_value: z.number(), measured_at: z.string().optional(), note: z.string().optional() });
const BenefitConfirmBody = z.object({ result: z.enum(['realized', 'not_realized']), notes: z.string().optional(), self_approval_reason: z.string().max(500).optional() });

@Controller('api/projects')
@Permissions('exec', 'planner', 'ar')
@RequiresSuite('projects')
export class ProjectsPortfolioController {
  constructor(private readonly svc: ProjectsService) {}

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

  // Period governance / status pack (PMO-3): the full per-project status report (EVM + health trend +
  // baseline variance + open-high risks + milestones + change-order log).
  @Get(':code/governance-pack')
  projectGovernancePack(@Param('code') code: string, @Query('period') period: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.governancePack(u, { code, period });
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

  // PPM-A2 (PROJ-23): resource leveling — over-allocated resource-months within this project cross-referenced
  // against the CPM schedule's slack, suggesting which task-linked assignment could shift later.
  @Get(':code/resource-leveling')
  resourceLeveling(@Param('code') code: string, @CurrentUser() u: JwtUser) {
    return this.svc.resourceLeveling(code, u);
  }

  // ── Portfolio selection scenarios (PPM Wave P4, PROJ-25) — what-if funding within a budget envelope +
  // maker-checker commit. Static `portfolio/*` paths sit above the `:code` param routes; inherit the class
  // gate (exec/planner/ar), with the commit's segregation-of-duties enforced in the service. ──
  @Post('portfolio/scenarios')
  createPortfolioScenario(@Body(new ZodValidationPipe(PortfolioScenarioBody)) b: PortfolioScenarioDto, @CurrentUser() u: JwtUser) {
    return this.svc.createPortfolioScenario(b, u);
  }

  @Get('portfolio/scenarios')
  listPortfolioScenarios(@CurrentUser() u: JwtUser) {
    return this.svc.listPortfolioScenarios(u);
  }

  @Get('portfolio/scenarios/:scenarioNo')
  getPortfolioScenario(@Param('scenarioNo') scenarioNo: string) {
    return this.svc.getPortfolioScenario(scenarioNo);
  }

  @Post('portfolio/scenarios/:scenarioNo/items')
  upsertPortfolioItem(@Param('scenarioNo') scenarioNo: string, @Body(new ZodValidationPipe(PortfolioItemBody)) b: PortfolioItemDto, @CurrentUser() u: JwtUser) {
    return this.svc.upsertPortfolioItem(scenarioNo, b, u);
  }

  @Delete('portfolio/scenarios/:scenarioNo/items/:projectCode')
  removePortfolioItem(@Param('scenarioNo') scenarioNo: string, @Param('projectCode') projectCode: string, @CurrentUser() u: JwtUser) {
    return this.svc.removePortfolioItem(scenarioNo, projectCode, u);
  }

  @Post('portfolio/scenarios/:scenarioNo/commit')
  commitPortfolioScenario(@Param('scenarioNo') scenarioNo: string, @Body(new ZodValidationPipe(PortfolioCommitBody)) b: PortfolioCommitDto, @CurrentUser() u: JwtUser) {
    return this.svc.commitPortfolioScenario(scenarioNo, b, u);
  }

  // ── Project phase-gate governance (PPM Wave P4, PROJ-26) — a project advances through its lifecycle phases
  // only through a gate that is submitted then independently decided (GO/HOLD/KILL, decider ≠ submitter).
  // Inherits the class gate (exec/planner/ar); the segregation-of-duties check is enforced in the service. ──
  @Get(':code/gates')
  listPhaseGates(@Param('code') code: string) {
    return this.svc.listPhaseGates(code);
  }

  @Post(':code/gates')
  submitPhaseGate(@Param('code') code: string, @Body(new ZodValidationPipe(PhaseGateBody)) b: PhaseGateDto, @CurrentUser() u: JwtUser) {
    return this.svc.submitPhaseGate(code, b, u);
  }

  @Post('gates/:gateId/decide')
  decidePhaseGate(@Param('gateId') gateId: string, @Body(new ZodValidationPipe(GateDecisionBody)) b: GateDecisionDto, @CurrentUser() u: JwtUser) {
    return this.svc.decidePhaseGate(Number(gateId), b, u);
  }

  // ── Program benefits realization (PPM Wave P4, PROJ-27) — declare expected benefits, log actuals over time,
  // and close each realized/not-realized as a maker-checker sign-off (confirmer ≠ author). Inherits the class
  // gate (exec/planner/ar); the segregation-of-duties check is enforced in the service. ──
  @Get('programs/:programCode/benefits')
  listProgramBenefits(@Param('programCode') programCode: string) {
    return this.svc.listProgramBenefits(programCode);
  }

  @Post('programs/:programCode/benefits')
  declareProgramBenefit(@Param('programCode') programCode: string, @Body(new ZodValidationPipe(BenefitBody)) b: BenefitDto, @CurrentUser() u: JwtUser) {
    return this.svc.declareProgramBenefit(programCode, b, u);
  }

  @Post('benefits/:benefitId/measurements')
  recordBenefitMeasurement(@Param('benefitId') benefitId: string, @Body(new ZodValidationPipe(BenefitMeasurementBody)) b: BenefitMeasurementDto, @CurrentUser() u: JwtUser) {
    return this.svc.recordBenefitMeasurement(Number(benefitId), b, u);
  }

  @Post('benefits/:benefitId/confirm')
  confirmProgramBenefit(@Param('benefitId') benefitId: string, @Body(new ZodValidationPipe(BenefitConfirmBody)) b: BenefitConfirmDto, @CurrentUser() u: JwtUser) {
    return this.svc.confirmProgramBenefit(Number(benefitId), b, u);
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

  // ── Working calendar (PPM-B1, PROJ-21) ── opt-in per-tenant non-working-weekday/holiday set. Static segments.
  @Get('calendar')
  getCalendar(@CurrentUser() u: JwtUser) {
    return this.svc.getCalendar(u);
  }

  @Put('calendar')
  setCalendar(@Body(new ZodValidationPipe(CalendarBody)) b: ProjectCalendarDto, @CurrentUser() u: JwtUser) {
    return this.svc.setCalendar(b, u);
  }

  @Post('calendar/exceptions')
  addCalendarException(@Body(new ZodValidationPipe(CalendarExceptionBody)) b: CalendarExceptionDto, @CurrentUser() u: JwtUser) {
    return this.svc.addCalendarException(b, u);
  }

  @Get('calendar/exceptions')
  listCalendarExceptions(@CurrentUser() u: JwtUser) {
    return this.svc.listCalendarExceptions(u);
  }

  // PROJ-03 — period-end WIP/clearing close review + maker-checker sign-off (controller/finance: 'exec').
  @Post('close-review') @Permissions('exec')
  prepareCloseReview(@Query('period') period: string, @CurrentUser() u: JwtUser) { return this.svc.prepareCloseReview(period, u); }

  @Post('close-review/:period/approve') @Permissions('exec')
  approveCloseReview(@Param('period') period: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) { return this.svc.approveCloseReview(period, u, b?.self_approval_reason); }

  @Post('close-review/:period/reject') @Permissions('exec')
  rejectCloseReview(@Param('period') period: string, @Body(new ZodValidationPipe(z.object({ reason: z.string().optional() }))) b: { reason?: string }, @CurrentUser() u: JwtUser) { return this.svc.rejectCloseReview(period, b.reason ?? '', u); }

  @Get('close-review/:period') @Permissions('exec')
  getCloseReview(@Param('period') period: string, @CurrentUser() u: JwtUser) { return this.svc.getCloseReview(period, u); }

  @Get('close-reviews') @Permissions('exec')
  listCloseReviews(@CurrentUser() u: JwtUser) { return this.svc.listCloseReviews(u); }
}

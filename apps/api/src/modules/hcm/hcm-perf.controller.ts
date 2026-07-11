import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  HcmPerfService,
  type CycleDto, type GoalDto, type GoalPatchDto, type ReviewDto, type ManagerRatingDto, type SignDto,
} from './hcm-perf.service';

const CycleBody = z.object({ name: z.string().min(1), period_start: z.string().optional(), period_end: z.string().optional() });
const GoalBody = z.object({ cycle_id: z.number().int().positive(), emp_code: z.string().min(1), title: z.string().min(1), description: z.string().optional(), weight_pct: z.number().nonnegative().optional(), metric: z.string().optional(), target: z.string().optional(), status: z.enum(['draft', 'active', 'achieved', 'missed']).optional() });
const GoalPatchBody = z.object({ progress_pct: z.number().optional(), status: z.enum(['draft', 'active', 'achieved', 'missed']).optional() });
const ReviewBody = z.object({ cycle_id: z.number().int().positive(), emp_code: z.string().min(1), self_rating: z.number().optional(), comments: z.string().optional() });
const ManagerBody = z.object({ manager_emp_code: z.string().min(1), manager_rating: z.number(), comments: z.string().optional() });
const SignBody = z.object({ calibrated_rating: z.number().optional() });

// HR-3 Performance management. Reads: hr / hr_admin / exec / ess (own, self-scoped in the service). Writes:
// hr / hr_admin. Sign-off: hr_admin / exec. Control HR-03 enforces the review sign-off SoD in the service.
@Controller('api/hcm/performance')
@Permissions('hr', 'hr_admin', 'exec', 'ess')
@RequiresSuite('hcm')
export class HcmPerfController {
  constructor(private readonly svc: HcmPerfService) {}

  // ── Cycles ──
  @Get('cycles')
  listCycles(@CurrentUser() u: JwtUser) { return this.svc.listCycles(u); }

  @Post('cycles')
  @Permissions('hr', 'hr_admin')
  createCycle(@Body(new ZodValidationPipe(CycleBody)) b: CycleDto, @CurrentUser() u: JwtUser) { return this.svc.createCycle(b, u); }

  @Post('cycles/:id/close')
  @Permissions('hr_admin', 'exec')
  closeCycle(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.closeCycle(Number(id), u); }

  // ── Goals ──
  @Get('goals')
  listGoals(@Query('cycle_id') cycleId: string | undefined, @Query('emp_code') empCode: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listGoals(cycleId != null ? Number(cycleId) : undefined, empCode, u);
  }

  @Post('goals')
  @Permissions('hr', 'hr_admin')
  createGoal(@Body(new ZodValidationPipe(GoalBody)) b: GoalDto, @CurrentUser() u: JwtUser) { return this.svc.createGoal(b, u); }

  @Patch('goals/:id')
  @Permissions('hr', 'hr_admin')
  patchGoal(@Param('id') id: string, @Body(new ZodValidationPipe(GoalPatchBody)) b: GoalPatchDto, @CurrentUser() u: JwtUser) { return this.svc.patchGoal(Number(id), b, u); }

  // ── Reviews (HR-03) ──
  @Get('reviews')
  listReviews(@Query('cycle_id') cycleId: string | undefined, @Query('emp_code') empCode: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listReviews(cycleId != null ? Number(cycleId) : undefined, empCode, u);
  }

  @Post('reviews')
  @Permissions('hr', 'hr_admin')
  createReview(@Body(new ZodValidationPipe(ReviewBody)) b: ReviewDto, @CurrentUser() u: JwtUser) { return this.svc.createReview(b, u); }

  @Post('reviews/:id/manager')
  @Permissions('hr', 'hr_admin')
  managerRate(@Param('id') id: string, @Body(new ZodValidationPipe(ManagerBody)) b: ManagerRatingDto, @CurrentUser() u: JwtUser) { return this.svc.managerRate(Number(id), b, u); }

  @Post('reviews/:id/sign')
  @Permissions('hr_admin', 'exec')
  signReview(@Param('id') id: string, @Body(new ZodValidationPipe(SignBody)) b: SignDto, @CurrentUser() u: JwtUser) { return this.svc.signReview(Number(id), b, u); }
}

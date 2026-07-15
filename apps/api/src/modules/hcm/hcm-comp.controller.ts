import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { SelfApprovalBody, type SelfApprovalDto } from '../../common/control-profile';
import {
  HcmCompService,
  type PayGradeDto, type CompChangeDto, type BenefitPlanDto, type EnrollmentDto,
} from './hcm-comp.service';

const GradeBody = z.object({
  grade_code: z.string().min(1), name: z.string().min(1),
  min_salary: z.number().nonnegative().optional(), mid_salary: z.number().nonnegative().optional(),
  max_salary: z.number().nonnegative().optional(), currency: z.string().optional(), active: z.boolean().optional(),
});
const ChangeBody = z.object({
  emp_code: z.string().min(1), change_type: z.enum(['hire', 'merit', 'promotion', 'adjustment']),
  new_salary: z.number().nonnegative(), new_grade: z.string().optional(), effective_date: z.string().optional(),
  reason: z.string().optional(), override: z.boolean().optional(),
});
const PlanBody = z.object({
  plan_code: z.string().min(1), name: z.string().min(1), category: z.enum(['health', 'dental', 'life', 'provident_fund', 'allowance']),
  employer_cost: z.number().nonnegative().optional(), employee_cost: z.number().nonnegative().optional(), active: z.boolean().optional(),
});
const EnrollBody = z.object({ emp_code: z.string().min(1), plan_code: z.string().min(1), enrolled_date: z.string().optional() });
const EndBody = z.object({ end_date: z.string().optional() });

// HR-6 (docs/42, Wave 2) — Compensation bands + benefits. Reads: hr / hr_admin / exec (enrollments also `ess`,
// own-scoped in the service). Writes: hr / hr_admin. Approvals: hr_admin / exec. Control HR-06 (comp-change
// maker-checker within band) is enforced in the service (OUT_OF_BAND at request, SOD_SELF_APPROVAL at approval).
@Controller('api/hcm/comp')
@RequiresSuite('hcm')
export class HcmCompController {
  constructor(private readonly svc: HcmCompService) {}

  // ── Pay grades ──
  @Get('grades')
  @Permissions('hr', 'hr_admin', 'exec')
  listGrades(@CurrentUser() u: JwtUser) { return this.svc.listGrades(u); }

  @Post('grades')
  @Permissions('hr', 'hr_admin')
  createGrade(@Body(new ZodValidationPipe(GradeBody)) b: PayGradeDto, @CurrentUser() u: JwtUser) { return this.svc.createGrade(b, u); }

  // ── Comp changes (HR-06) ──
  @Get('changes')
  @Permissions('hr', 'hr_admin', 'exec')
  listChanges(@Query('emp_code') emp: string | undefined, @Query('status') status: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listChanges(emp, status, u); }

  @Post('changes')
  @Permissions('hr', 'hr_admin')
  createChange(@Body(new ZodValidationPipe(ChangeBody)) b: CompChangeDto, @CurrentUser() u: JwtUser) { return this.svc.createChange(b, u); }

  // HR-06 — the approver must differ from the requester (SOD_SELF_APPROVAL).
  // (an 'sme' tenant may self-approve WITH self_approval_reason — docs/49, SME-01.)
  @Post('changes/:id/approve')
  @Permissions('hr_admin', 'exec')
  approveChange(@Param('id') id: string, @CurrentUser() u: JwtUser, @Body(new ZodValidationPipe(SelfApprovalBody)) b?: SelfApprovalDto) { return this.svc.approveChange(Number(id), u, b?.self_approval_reason); }

  @Post('changes/:id/reject')
  @Permissions('hr_admin', 'exec')
  rejectChange(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.rejectChange(Number(id), u); }

  // ── Benefit plans ──
  @Get('benefit-plans')
  @Permissions('hr', 'hr_admin', 'exec')
  listBenefitPlans(@CurrentUser() u: JwtUser) { return this.svc.listBenefitPlans(u); }

  @Post('benefit-plans')
  @Permissions('hr', 'hr_admin')
  createBenefitPlan(@Body(new ZodValidationPipe(PlanBody)) b: BenefitPlanDto, @CurrentUser() u: JwtUser) { return this.svc.createBenefitPlan(b, u); }

  // ── Benefit enrollments (reads also `ess`, own-scoped in the service) ──
  @Get('enrollments')
  @Permissions('hr', 'hr_admin', 'exec', 'ess')
  listEnrollments(@Query('emp_code') emp: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listEnrollments(emp, u); }

  @Post('enrollments')
  @Permissions('hr', 'hr_admin')
  createEnrollment(@Body(new ZodValidationPipe(EnrollBody)) b: EnrollmentDto, @CurrentUser() u: JwtUser) { return this.svc.createEnrollment(b, u); }

  @Post('enrollments/:id/end')
  @Permissions('hr', 'hr_admin')
  endEnrollment(@Param('id') id: string, @Body(new ZodValidationPipe(EndBody)) b: { end_date?: string }, @CurrentUser() u: JwtUser) { return this.svc.endEnrollment(Number(id), b.end_date, u); }
}

import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  HcmTrainingService,
  type CourseDto, type SessionDto, type EnrollDto, type CompleteDto,
} from './hcm-training.service';

const CourseBody = z.object({
  course_code: z.string().min(1), name: z.string().min(1),
  category: z.enum(['safety', 'compliance', 'technical', 'general']).optional(),
  is_mandatory: z.boolean().optional(), requires_score: z.boolean().optional(),
  pass_score: z.number().nonnegative().optional(), validity_months: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
});
const SessionBody = z.object({
  course_code: z.string().min(1), session_date: z.string().optional(), instructor: z.string().optional(),
  location: z.string().optional(), capacity: z.number().int().positive().optional(),
});
const EnrollBody = z.object({ session_id: z.number().int().positive(), emp_code: z.string().min(1) });
const CompleteBody = z.object({
  status: z.enum(['completed', 'failed']).optional(), score: z.number().optional(), completed_date: z.string().optional(),
});

// HR-7 (docs/42, Wave 3) — Training & Certifications. Reads: hr / hr_admin / exec (enrollments &
// certifications also `ess`, own-scoped in the service). Writes: hr / hr_admin. Control HR-07
// (mandatory-training / certification compliance) is enforced in the service: the SCORE_REQUIRED gate on
// completion, the automated certification mint on completion (expiry = completed_date + validity_months),
// and the detective compliance read (expired/expiring mandatory certifications).
@Controller('api/hcm/training')
@RequiresSuite('hcm')
export class HcmTrainingController {
  constructor(private readonly svc: HcmTrainingService) {}

  // ── Courses ──
  @Get('courses')
  @Permissions('hr', 'hr_admin', 'exec')
  listCourses(@CurrentUser() u: JwtUser) { return this.svc.listCourses(u); }

  @Post('courses')
  @Permissions('hr', 'hr_admin')
  createCourse(@Body(new ZodValidationPipe(CourseBody)) b: CourseDto, @CurrentUser() u: JwtUser) { return this.svc.createCourse(b, u); }

  // ── Sessions ──
  @Get('sessions')
  @Permissions('hr', 'hr_admin', 'exec')
  listSessions(@Query('course_code') course: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listSessions(course, u); }

  @Post('sessions')
  @Permissions('hr', 'hr_admin')
  createSession(@Body(new ZodValidationPipe(SessionBody)) b: SessionDto, @CurrentUser() u: JwtUser) { return this.svc.createSession(b, u); }

  // ── Enrollments (reads also `ess`, own-scoped in the service) ──
  @Get('enrollments')
  @Permissions('hr', 'hr_admin', 'exec', 'ess')
  listEnrollments(@Query('emp_code') emp: string | undefined, @Query('session_id') session: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.listEnrollments(emp, session != null ? Number(session) : undefined, u);
  }

  @Post('enrollments')
  @Permissions('hr', 'hr_admin')
  enroll(@Body(new ZodValidationPipe(EnrollBody)) b: EnrollDto, @CurrentUser() u: JwtUser) { return this.svc.enroll(b, u); }

  // HR-07 — complete an enrollment (SCORE_REQUIRED gate; mints/renews a certification on success).
  @Post('enrollments/:id/complete')
  @Permissions('hr', 'hr_admin')
  complete(@Param('id') id: string, @Body(new ZodValidationPipe(CompleteBody)) b: CompleteDto, @CurrentUser() u: JwtUser) { return this.svc.complete(Number(id), b, u); }

  // ── Certifications (reads also `ess`, own-scoped in the service) ──
  @Get('certifications')
  @Permissions('hr', 'hr_admin', 'exec', 'ess')
  listCertifications(@Query('emp_code') emp: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listCertifications(emp, u); }

  // HR-07 detective read — expired / expiring-within-N-days mandatory certifications.
  @Get('compliance')
  @Permissions('hr', 'hr_admin', 'exec')
  compliance(@Query('days') days: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.compliance(days != null ? Number(days) : undefined, u); }
}

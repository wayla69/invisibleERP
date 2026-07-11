import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { HcmLifecycleService, type TemplateDto, type TemplateTaskDto, type StartDto, type PatchTaskDto } from './hcm-lifecycle.service';

const TemplateBody = z.object({
  code: z.string().min(1), name: z.string().min(1), kind: z.enum(['onboarding', 'offboarding']).optional(), active: z.boolean().optional(),
});
const TemplateTaskBody = z.object({
  title: z.string().min(1), seq: z.number().int().positive().optional(), owner_role: z.string().optional(),
  category: z.string().optional(), is_access_revocation: z.boolean().optional(),
});
const StartBody = z.object({ emp_code: z.string().min(1), template_id: z.number().int().positive() });
const PatchTaskBody = z.object({ status: z.enum(['done', 'skipped']), notes: z.string().optional(), reason: z.string().optional() });

// HR-5 (docs/42) — onboarding / offboarding lifecycle. Reads open to hr/hr_admin/exec; writes to hr/hr_admin
// (the guard grants on ANY listed permission; Admin bypasses). The HR-05 access-revocation-completeness
// control (offboarding cannot complete while an access-revocation task is pending) lives in the service.
@Controller('api/hcm/lifecycle')
@RequiresSuite('hcm')
export class HcmLifecycleController {
  constructor(private readonly svc: HcmLifecycleService) {}

  @Get('templates')
  @Permissions('hr', 'hr_admin', 'exec')
  listTemplates(@Query('kind') kind: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listTemplates(kind, u); }

  @Post('templates')
  @Permissions('hr', 'hr_admin')
  createTemplate(@Body(new ZodValidationPipe(TemplateBody)) b: TemplateDto, @CurrentUser() u: JwtUser) { return this.svc.createTemplate(b, u); }

  @Post('templates/:id/tasks')
  @Permissions('hr', 'hr_admin')
  addTemplateTask(@Param('id') id: string, @Body(new ZodValidationPipe(TemplateTaskBody)) b: TemplateTaskDto, @CurrentUser() u: JwtUser) { return this.svc.addTemplateTask(Number(id), b, u); }

  @Post('start')
  @Permissions('hr', 'hr_admin')
  start(@Body(new ZodValidationPipe(StartBody)) b: StartDto, @CurrentUser() u: JwtUser) { return this.svc.start(b, u); }

  @Get()
  @Permissions('hr', 'hr_admin', 'exec')
  list(@Query('emp_code') empCode: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.list(empCode, u); }

  // HR-05 detective read — open offboardings with unrevoked access past N days (default 7).
  @Get('offboarding-exceptions')
  @Permissions('hr', 'hr_admin', 'exec')
  offboardingExceptions(@Query('days') days: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.offboardingExceptions(days == null ? 7 : Number(days), u); }

  // Mark a task done/skipped. Skipping an access-revocation task needs hr_admin/exec + a reason (audit-logged).
  @Patch('tasks/:id')
  @Permissions('hr', 'hr_admin')
  patchTask(@Param('id') id: string, @Body(new ZodValidationPipe(PatchTaskBody)) b: PatchTaskDto, @CurrentUser() u: JwtUser) { return this.svc.patchTask(Number(id), b, u); }

  // HR-05 — an offboarding cannot complete while any access-revocation task is still pending.
  @Post(':id/complete')
  @Permissions('hr', 'hr_admin')
  complete(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.complete(Number(id), u); }
}

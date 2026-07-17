import { Controller, Get, Post, Put, Body, Query, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CloseService } from './close.service';

const TaskTemplatesBody = z.object({
  templates: z.array(z.object({
    step_key: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/),
    title: z.string().min(1).max(200),
    required: z.boolean().optional(),
    seq: z.number().int().optional(),
    owner_role: z.string().max(60).optional(),
    due_day_offset: z.number().int().min(-31).max(60).optional(),
    depends_on_key: z.string().max(60).optional(),
    active: z.boolean().optional(),
  })).max(50),
});
type TaskTemplatesBodyT = z.infer<typeof TaskTemplatesBody>;
const StartBody = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/, 'period must be YYYY-MM') });
type StartBodyT = z.infer<typeof StartBody>;

const StepBody = z.object({
  close_run_id: z.number().int().positive(),
  step_key: z.string().min(1),
  detail: z.any().optional(),
});
type StepBodyT = z.infer<typeof StepBody>;

const LockBody = z.object({ close_run_id: z.number().int().positive(), self_approval_reason: z.string().max(500).optional() });
const AutoCompleteBody = z.object({ close_run_id: z.number().int().positive() });
type AutoCompleteBodyT = z.infer<typeof AutoCompleteBody>;
type LockBodyT = z.infer<typeof LockBody>;

const ReopenBody = z.object({ close_run_id: z.number().int().positive(), reason: z.string().optional(), self_approval_reason: z.string().max(500).optional() });
type ReopenBodyT = z.infer<typeof ReopenBody>;

// WS2.1 — Hard period close + checklist (GL-15/GL-16). startClose seeds the checklist; completeStep marks
// steps Done; lockPeriod hard-locks the period (maker-checker: locker ≠ starter, SELF_LOCK).
@Controller('api/ledger/close')
export class CloseController {
  constructor(private readonly svc: CloseService) {}

  @Get()
  @Permissions('gl_close', 'gl_post', 'exec')
  list() {
    return this.svc.list();
  }

  @Get('status')
  @Permissions('gl_close', 'gl_post', 'exec')
  status(@Query('period') period: string) {
    return this.svc.status(period);
  }

  // GL-19 — programmatic pre-lock validation: read-only readiness checks (no unposted drafts, balanced
  // entries, suspense/clearing near-zero) surfaced as advisory blockers before the maker-checker lock.
  @Get('validate')
  @Permissions('gl_close', 'gl_post', 'exec')
  validate(@Query('period') period: string) {
    return this.svc.validate(period);
  }

  // B1 (docs/50 Wave 3) — Close Manager task templates: read for any close principal; change gl_close/exec.
  @Get('task-templates')
  @Permissions('gl_close', 'gl_post', 'exec')
  taskTemplates() {
    return this.svc.listTaskTemplates();
  }

  @Put('task-templates')
  @Permissions('gl_close', 'exec')
  putTaskTemplates(@Body(new ZodValidationPipe(TaskTemplatesBody)) b: TaskTemplatesBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.putTaskTemplates({ templates: b.templates }, u);
  }

  @Post('start')
  @HttpCode(201)
  @Permissions('gl_close')
  start(@Body(new ZodValidationPipe(StartBody)) b: StartBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.startClose({ period: b.period, startedBy: u.username });
  }

  @Post('step')
  @HttpCode(200)
  @Permissions('gl_close')
  step(@Body(new ZodValidationPipe(StepBody)) b: StepBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.completeStep({ closeRunId: b.close_run_id, stepKey: b.step_key, completedBy: u.username, detail: b.detail });
  }

  // Close Manager v2 (docs/50 follow-up) — evidence-driven auto-complete: only system-verifiable steps
  // (recurring/fx_reval/deferred_tax/depreciation) flip Done, attributed "(auto)" with the evidence pinned.
  @Post('auto-complete')
  @HttpCode(200)
  @Permissions('gl_close')
  autoComplete(@Body(new ZodValidationPipe(AutoCompleteBody)) b: AutoCompleteBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.autoComplete(b.close_run_id, u);
  }

  @Post('lock')
  @HttpCode(200)
  @Permissions('gl_close')
  lock(@Body(new ZodValidationPipe(LockBody)) b: LockBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.lockPeriod({ closeRunId: b.close_run_id, lockedBy: u.username }, u, b.self_approval_reason);
  }

  // GL-16b — controlled emergency reopen of a Locked period (mandatory reason; reopener ≠ locker; audited).
  @Post('reopen')
  @HttpCode(200)
  @Permissions('gl_close')
  reopen(@Body(new ZodValidationPipe(ReopenBody)) b: ReopenBodyT, @CurrentUser() u: JwtUser) {
    return this.svc.reopenPeriod({ closeRunId: b.close_run_id, reopenedBy: u.username, reason: b.reason ?? '' }, u, b.self_approval_reason);
  }
}

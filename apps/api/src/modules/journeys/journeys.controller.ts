import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, NoTx, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { JourneysService } from './journeys.service';

const Rule = z.object({ field: z.string(), op: z.string(), value: z.any() });
const Step = z.object({ wait_days: z.number().int().min(0).default(0), channel: z.enum(['sms', 'email', 'line']).default('sms'), body: z.string().min(1), skip_rule: Rule.optional().nullable(), branch_rule: Rule.optional().nullable(), branch_to_step: z.number().int().positive().optional().nullable() });
const JourneyBody = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().min(1),
  trigger: z.enum(['manual', 'segment']).default('manual'),
  segment_id: z.number().int().positive().optional(),
  cap_messages: z.number().int().min(0).default(0),
  cap_window_days: z.number().int().min(1).default(7),
  default_send_hour: z.number().int().min(0).max(23).default(10),
  steps: z.array(Step).min(1),
});
const EnrollBody = z.object({ member_id: z.number().int().positive() });

// Lifecycle journeys (Phase G1, docs/25). Config + run are marketing/exec actions (segregated from
// POS/finance, same gate as campaigns). The runner also fires from the BI scheduler (`journey_runner`).
@Controller('api/loyalty/journeys')
export class JourneysController {
  constructor(private readonly svc: JourneysService) {}

  @Get() @Permissions('loyalty', 'marketing', 'exec')
  list(@CurrentUser() u: JwtUser) { return this.svc.list(u); }

  @Post() @Permissions('marketing', 'exec')
  upsert(@Body(new ZodValidationPipe(JourneyBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.upsert(b, u); }

  @Post(':id/activate') @Permissions('marketing', 'exec')
  activate(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.setStatus(+id, 'active', u); }

  @Post(':id/pause') @Permissions('marketing', 'exec')
  pause(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.setStatus(+id, 'paused', u); }

  @Post(':id/enroll') @Permissions('marketing', 'exec')
  enroll(@Param('id') id: string, @Body(new ZodValidationPipe(EnrollBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.enroll(+id, b.member_id, u); }

  // @NoTx — gateway sends are irreversible; each enrollment-step CLAIM must commit before its delivery so a
  // crash/rollback can never re-fire a step (at-most-once, MKT-12). Mirrors the campaign run-due route.
  @Post('run-due') @NoTx() @Permissions('marketing', 'exec')
  runDue(@CurrentUser() u: JwtUser) { return this.svc.runDueAll(u); }
}

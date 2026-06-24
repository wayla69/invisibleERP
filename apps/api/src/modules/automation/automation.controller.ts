import { Controller, Get, Post, Put, Delete, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AutomationService } from './automation.service';

const Action = z.object({ type: z.string() }).passthrough();
const CreateBody = z.object({
  name: z.string().min(1),
  event_type: z.string().min(1),
  condition: z.record(z.string(), z.any()).nullish(),
  action: Action,
});
const UpdateBody = z.object({
  name: z.string().min(1).optional(),
  condition: z.record(z.string(), z.any()).nullish(),
  action: Action.optional(),
  active: z.boolean().optional(),
});
const RunBody = z.object({ event: z.string().min(1), payload: z.record(z.string(), z.any()).optional() });

// Automation rules engine (Phase 13 — A4) — no-code "when EVENT [and CONDITION] then ACTION". Presentation/
// operational only; actions never post to the ledger. Gated to admin / master-data / exec.
@Controller('api/automation')
export class AutomationController {
  constructor(private readonly svc: AutomationService) {}

  @Get('events') @Permissions('masterdata', 'users', 'exec')
  events() { return this.svc.catalog(); }

  @Get('rules') @Permissions('masterdata', 'users', 'exec')
  list(@CurrentUser() u: JwtUser) { return this.svc.listRules(u); }

  @Post('rules') @Permissions('masterdata', 'users', 'exec')
  create(@Body(new ZodValidationPipe(CreateBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createRule(b, u); }

  @Put('rules/:id') @Permissions('masterdata', 'users', 'exec')
  update(@Param('id') id: string, @Body(new ZodValidationPipe(UpdateBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.updateRule(+id, b, u); }

  @Delete('rules/:id') @Permissions('masterdata', 'users', 'exec')
  remove(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.removeRule(+id, u); }

  @Get('executions') @Permissions('masterdata', 'users', 'exec')
  execs(@Query('limit') l: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.listExecutions(u, l ? +l : 50); }

  @Post('run-event') @Permissions('users', 'exec')
  run(@Body(new ZodValidationPipe(RunBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.runEvent(b.event, b.payload ?? {}, u); }
}

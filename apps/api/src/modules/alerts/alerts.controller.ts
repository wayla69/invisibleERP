import { Controller, Get, Post, Patch, Delete, Param, Body, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AlertsService } from './alerts.service';

const RuleBody = z.object({
  name: z.string().min(1),
  metric: z.string().min(1),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']).default('gte'),
  threshold: z.number(),
  channel: z.enum(['notification', 'line', 'sms', 'email']).default('notification'),
  target_role: z.string().optional(),
  target_to: z.string().optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  cooldown_hours: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
});
const ActiveBody = z.object({ active: z.boolean() });

@Controller('api/alerts')
@Permissions('masterdata', 'exec', 'users', 'dashboard')
export class AlertsController {
  constructor(private readonly svc: AlertsService) {}

  @Get('metrics') metrics() { return this.svc.metrics(); }
  @Get('preview') preview(@CurrentUser() u: JwtUser) { return this.svc.preview(u); }

  @Get('rules') rules(@CurrentUser() u: JwtUser) { return this.svc.listRules(u); }
  @Post('rules') @Permissions('masterdata', 'exec', 'users') create(@Body(new ZodValidationPipe(RuleBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.createRule(b, u); }
  @Patch('rules/:id') @Permissions('masterdata', 'exec', 'users') setActive(@Param('id') id: string, @Body(new ZodValidationPipe(ActiveBody)) b: any, @CurrentUser() u: JwtUser) { return this.svc.setActive(+id, b.active, u); }
  @Delete('rules/:id') @Permissions('masterdata', 'exec', 'users') remove(@Param('id') id: string, @CurrentUser() u: JwtUser) { return this.svc.removeRule(+id, u); }

  @Get('events') events(@Query('limit') l: string | undefined, @CurrentUser() u: JwtUser) { return this.svc.events(u, l ? +l : 100); }
  // cron-callable sweep
  @Post('run') run(@CurrentUser() u: JwtUser) { return this.svc.run(u); }
}

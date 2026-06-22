import { Controller, Get, Post, Body, Param, ParseIntPipe, Query, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { PipelineService } from './pipeline.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

const OppBody = z.object({ name: z.string().min(1), account_name: z.string().optional(), stage_name: z.string().optional(), expected_value: z.number().optional(), expected_close: z.string().optional(), assigned_to: z.string().optional(), notes: z.string().optional() });
const MoveBody = z.object({ stage_name: z.string().min(1) });
const CloseBody = z.object({ outcome: z.enum(['Won', 'Lost']), reason: z.string().optional() });
const ActivityBody = z.object({ activity_type: z.string().min(1), subject: z.string().min(1), notes: z.string().optional(), activity_date: z.string().optional() });

@Controller('api/pipeline')
export class PipelineController {
  constructor(private readonly svc: PipelineService) {}

  @Get('stages')
  @Permissions('crm')
  listStages(@CurrentUser() user: JwtUser) { return this.svc.listStages(user); }

  @Get('opportunities')
  @Permissions('crm')
  list(@Query('status') status?: string, @Query('stage') stage?: string, @CurrentUser() user?: JwtUser) {
    return this.svc.listOpportunities({ status, stage_name: stage }, user!);
  }

  @Post('opportunities')
  @Permissions('crm')
  create(@Body(new ZodValidationPipe(OppBody)) dto: z.infer<typeof OppBody>, @CurrentUser() user: JwtUser) { return this.svc.createOpportunity(dto, user); }

  @Post('opportunities/:id/move')
  @Permissions('crm')
  @HttpCode(200)
  move(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(MoveBody)) dto: z.infer<typeof MoveBody>, @CurrentUser() user: JwtUser) { return this.svc.moveStage(id, dto, user); }

  @Post('opportunities/:id/close')
  @Permissions('crm')
  @HttpCode(200)
  close(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(CloseBody)) dto: z.infer<typeof CloseBody>, @CurrentUser() user: JwtUser) { return this.svc.closeOpportunity(id, dto, user); }

  @Post('opportunities/:id/activities')
  @Permissions('crm')
  addActivity(@Param('id', ParseIntPipe) id: number, @Body(new ZodValidationPipe(ActivityBody)) dto: z.infer<typeof ActivityBody>, @CurrentUser() user: JwtUser) { return this.svc.addActivity(id, dto, user); }

  @Get('opportunities/:id/activities')
  @Permissions('crm')
  getActivities(@Param('id', ParseIntPipe) id: number) { return this.svc.listActivities(id); }

  @Get('forecast')
  @Permissions('exec')
  forecast(@CurrentUser() user: JwtUser) { return this.svc.forecast(user); }
}

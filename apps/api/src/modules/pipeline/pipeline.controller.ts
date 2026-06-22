import { Controller, Get, Post, Body, Param, ParseIntPipe, Query, HttpCode } from '@nestjs/common';
import { PipelineService } from './pipeline.service';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

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
  create(@Body() dto: any, @CurrentUser() user: JwtUser) { return this.svc.createOpportunity(dto, user); }

  @Post('opportunities/:id/move')
  @Permissions('crm')
  @HttpCode(200)
  move(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: JwtUser) { return this.svc.moveStage(id, dto, user); }

  @Post('opportunities/:id/close')
  @Permissions('crm')
  @HttpCode(200)
  close(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: JwtUser) { return this.svc.closeOpportunity(id, dto, user); }

  @Post('opportunities/:id/activities')
  @Permissions('crm')
  addActivity(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @CurrentUser() user: JwtUser) { return this.svc.addActivity(id, dto, user); }

  @Get('opportunities/:id/activities')
  @Permissions('crm')
  getActivities(@Param('id', ParseIntPipe) id: number) { return this.svc.listActivities(id); }

  @Get('forecast')
  @Permissions('exec')
  forecast(@CurrentUser() user: JwtUser) { return this.svc.forecast(user); }
}

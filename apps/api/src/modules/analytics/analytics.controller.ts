import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { z } from 'zod';
import { Permissions } from '../../common/decorators';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { AnalyticsService } from './analytics.service';
import { qint, qintOpt } from '../../common/query';

const InsightBody = z.object({ type: z.string(), data: z.record(z.any()) });

@Controller('api/analytics')
export class AnalyticsController {
  constructor(private readonly svc: AnalyticsService) {}

  @Get('replenishment') @Permissions('planner', 'dashboard', 'warehouse')
  replenishment(@Query('limit') limit?: string) { return this.svc.replenishmentList(qint('limit', limit, 50)); }

  @Get('replenishment/:itemId') @Permissions('planner', 'dashboard', 'warehouse')
  replItem(@Param('itemId') itemId: string) { return this.svc.replenishmentItem(itemId); }

  @Get('anomalies') @Permissions('planner', 'dashboard', 'exec')
  anomalies(@Query('days') days?: string) { return this.svc.anomalySummary(qint('days', days, 30)); }

  @Post('insight') @Permissions('planner', 'dashboard')
  insight(@Body(new ZodValidationPipe(InsightBody)) b: { type: string; data: any }) { return this.svc.insight(b.type, b.data); }

  @Get('dashboard-summary') @Permissions('dashboard', 'exec', 'planner')
  summary() { return this.svc.dashboardSummary(); }
}

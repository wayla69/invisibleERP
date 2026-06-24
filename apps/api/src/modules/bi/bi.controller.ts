import { Controller, Get, Post, Delete, Body, Param, ParseIntPipe, Query, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { BiService } from './bi.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';
import { qint, qintOpt } from '../../common/query';

const RefreshBody = z.object({ date: z.string().optional() });
const SubscriptionBody = z.object({ name: z.string().min(1), report_type: z.string().min(1), frequency: z.string().min(1), filters: z.record(z.any()).optional(), recipients: z.array(z.record(z.any())).optional() });

@Controller('api/bi')
export class BiController {
  constructor(private readonly svc: BiService) {}

  @Get('kpi')
  @Permissions('exec')
  kpiBoard(@CurrentUser() user: JwtUser) { return this.svc.kpiBoard(user); }

  @Get('sales-cube')
  @Permissions('exec')
  salesCube(@Query('period') period?: string, @Query('months') months?: string, @Query('start') start?: string, @Query('end') end?: string, @CurrentUser() user?: JwtUser) {
    return this.svc.salesCube({ period: period as any, months: qintOpt('months', months), start_date: start, end_date: end }, user!);
  }

  @Get('finance-trend')
  @Permissions('exec')
  financeTrend(@Query('months') months?: string, @Query('ledger') ledger?: string, @CurrentUser() user?: JwtUser) {
    return this.svc.financeTrend({ months: qintOpt('months', months), ledger_code: ledger }, user!);
  }

  @Get('pipeline-trend')
  @Permissions('exec')
  pipelineTrend(@Query('months') months?: string, @CurrentUser() user?: JwtUser) {
    return this.svc.pipelineTrend({ months: qintOpt('months', months) }, user!);
  }

  @Post('snapshots/refresh')
  @Permissions('exec')
  @HttpCode(200)
  refresh(@Body(new ZodValidationPipe(RefreshBody)) dto: z.infer<typeof RefreshBody>, @CurrentUser() user: JwtUser) { return this.svc.refreshSnapshot(dto, user); }

  @Get('snapshots')
  @Permissions('exec')
  getSnapshots(@Query('days') days?: string, @Query('start') start?: string, @Query('end') end?: string, @CurrentUser() user?: JwtUser) {
    return this.svc.getSnapshots({ days: qintOpt('days', days), start_date: start, end_date: end }, user!);
  }

  @Get('report-types')
  @Permissions('exec')
  reportTypes() { return this.svc.reportTypes(); }

  @Get('subscriptions')
  @Permissions('exec')
  listSubs(@CurrentUser() user: JwtUser) { return this.svc.listSubscriptions(user); }

  @Post('subscriptions')
  @Permissions('exec')
  createSub(@Body(new ZodValidationPipe(SubscriptionBody)) dto: z.infer<typeof SubscriptionBody>, @CurrentUser() user: JwtUser) { return this.svc.createSubscription(dto, user); }

  @Post('subscriptions/run')
  @Permissions('exec')
  @HttpCode(200)
  runDue(@CurrentUser() user: JwtUser) { return this.svc.runDue(user); }

  @Post('subscriptions/:id/run')
  @Permissions('exec')
  @HttpCode(200)
  runNow(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.runSubscriptionNow(id, user); }

  @Delete('subscriptions/:id')
  @Permissions('exec')
  deleteSub(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: JwtUser) { return this.svc.deleteSubscription(id, user); }

  @Get('runs')
  @Permissions('exec')
  runs(@Query('limit') limit?: string, @CurrentUser() user?: JwtUser) { return this.svc.listRuns(user!, qintOpt('limit', limit)); }
}

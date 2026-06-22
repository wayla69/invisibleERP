import { Controller, Get, Post, Body, Query, HttpCode } from '@nestjs/common';
import { ProfitabilityService } from './profitability.service';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

@Controller('api/profitability')
export class ProfitabilityController {
  constructor(private readonly svc: ProfitabilityService) {}

  @Get('segments')
  @Permissions('exec')
  listSegments(@Query('type') type: string | undefined, @CurrentUser() user: JwtUser) {
    return this.svc.listSegments(type, user);
  }

  @Post('segments')
  @Permissions('masterdata')
  createSegment(@Body() dto: any, @CurrentUser() user: JwtUser) {
    return this.svc.createSegment(dto, user);
  }

  @Get('rules')
  @Permissions('exec')
  listRules(@CurrentUser() user: JwtUser) {
    return this.svc.listRules(user);
  }

  @Post('rules')
  @Permissions('masterdata')
  createRule(@Body() dto: any, @CurrentUser() user: JwtUser) {
    return this.svc.createRule(dto, user);
  }

  @Post('run')
  @Permissions('exec')
  @HttpCode(200)
  runAllocation(@Body() dto: any, @CurrentUser() user: JwtUser) {
    return this.svc.runAllocation(dto, user);
  }

  @Get('report')
  @Permissions('exec')
  report(@Query('period') period: string, @Query('segment_type') segmentType: string | undefined, @CurrentUser() user: JwtUser) {
    return this.svc.profitabilityReport({ period, segment_type: segmentType }, user);
  }
}

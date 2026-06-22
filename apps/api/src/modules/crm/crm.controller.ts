import { Controller, Get, Post, Body, Param, ParseIntPipe, HttpCode } from '@nestjs/common';
import { CrmService } from './crm.service';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

@Controller('api/crm')
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  // GET /api/crm/profile/:memberId — 360 customer view
  @Get('profile/:memberId')
  @Permissions('crm')
  profile(@Param('memberId', ParseIntPipe) memberId: number, @CurrentUser() user: JwtUser) {
    return this.crm.profile(memberId, user);
  }

  // POST /api/crm/profile/:memberId/refresh — recompute RFM profile
  @Post('profile/:memberId/refresh')
  @Permissions('crm')
  @HttpCode(200)
  async refresh(@Param('memberId', ParseIntPipe) memberId: number, @CurrentUser() user: JwtUser) {
    if (user.tenantId == null) return { error: 'No tenant context' };
    return this.crm.refreshProfile(user.tenantId, memberId);
  }

  // GET /api/crm/promos/:memberId — personalized promos for member
  @Get('promos/:memberId')
  @Permissions('crm')
  personalizedPromos(@Param('memberId', ParseIntPipe) memberId: number, @CurrentUser() user: JwtUser) {
    return this.crm.personalizedPromos(memberId, user);
  }

  // GET /api/crm/branch-kpi — today's branch performance dashboard
  @Get('branch-kpi')
  @Permissions('crm')
  branchKpi(@CurrentUser() user: JwtUser) {
    return this.crm.branchKpi(user);
  }

  // POST /api/crm/audience-rules — create/update targeting rule (AI personalization)
  @Post('audience-rules')
  @Permissions('marketing')
  upsertAudienceRule(@Body() dto: any, @CurrentUser() user: JwtUser) {
    return this.crm.upsertAudienceRule(dto, user);
  }
}

import { Controller, Get, Post, Body, Param, Query, ParseIntPipe, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { CrmService } from './crm.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';

const AudienceRuleBody = z.object({ promo_id: z.number().int(), rfm_segment: z.string().optional(), min_lifetime: z.number().optional(), min_frequency: z.number().optional(), preferred_channel: z.string().optional() });

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

  // GET /api/crm/export — bulk customer-data export for an external CDP (identity + RFM + consent). Paginated,
  // tenant-scoped (HQ/Admin pass ?tenant_id). Read-only; ships consent flags so the CDP honours opt-outs.
  @Get('export')
  @Permissions('marketing', 'exec')
  exportForCdp(
    @Query('tenant_id') tenantId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('offset') offset: string | undefined,
    @CurrentUser() user: JwtUser,
  ) {
    return this.crm.exportForCdp(user, {
      tenantId: tenantId != null ? Number(tenantId) : null,
      limit: limit != null ? Number(limit) : undefined,
      offset: offset != null ? Number(offset) : undefined,
    });
  }

  // POST /api/crm/audience-rules — create/update targeting rule (AI personalization)
  @Post('audience-rules')
  @Permissions('marketing')
  upsertAudienceRule(@Body(new ZodValidationPipe(AudienceRuleBody)) dto: z.infer<typeof AudienceRuleBody>, @CurrentUser() user: JwtUser) {
    return this.crm.upsertAudienceRule(dto, user);
  }
}

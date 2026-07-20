import { Controller, Get, Post, Body, Param, Query, ParseIntPipe, HttpCode } from '@nestjs/common';
import { z } from 'zod';
import { CrmService } from './crm.service';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentUser, Permissions } from '../../common/decorators';
import type { JwtUser } from '../../common/decorators';
import { RequiresSuite } from '../billing/requires-suite.decorator';

const RefreshAllBody = z.object({ tenant_id: z.number().int().positive().optional() }).optional();
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

  // GET /api/crm/customer-360/:accountNo — CRM-3 Customer 360: joins a CRM-1 account to the money
  // (AR/credit + statement + deals + quotes + loyalty + NPS/recovery) in ONE read. Read-only aggregator.
  @Get('customer-360/:accountNo')
  @Permissions('crm', 'exec', 'ar')
  customer360(@Param('accountNo') accountNo: string, @CurrentUser() user: JwtUser) {
    return this.crm.customer360(accountNo, user);
  }

  // G3 (docs/45, PDPA-05) — preview the hashed ads-audience export: counts + the first hashed rows, so a
  // marketer can SEE the consent gate and the hash-only payload before scheduling audience_export_sync.
  // 0451 — the ads-audience/CDP surfaces are the 'cdp' add-on suite (grandfathered into pro/franchise/
  // enterprise, which had the marketing token; others buy it à la carte). Inert unless ENTITLEMENTS_ENFORCE.
  @Get('audience-export/preview')
  @RequiresSuite('cdp')
  @Permissions('marketing', 'exec')
  audiencePreview(@Query('limit') limit: string | undefined, @CurrentUser() user: JwtUser) {
    return this.crm.exportForCustomerMatch(user, { limit: limit != null ? Number(limit) || 10 : 10 });
  }
  // G3 — the append-only export register (PDPA-05 evidence: every run — success, failed, or blocked).
  @Get('audience-export/register')
  @RequiresSuite('cdp')
  @Permissions('marketing', 'exec')
  audienceRegister(@Query('limit') limit: string | undefined, @CurrentUser() user: JwtUser) {
    return this.crm.audienceExportRegister(user, limit != null ? Number(limit) || 50 : 50);
  }

  // POST /api/crm/profiles/refresh — bulk RFM re-profiling for the whole active member base (Phase F2).
  // On-demand counterpart of the scheduled `crm_profile_refresh` BI job — e.g. force-fresh before a big send.
  @Post('profiles/refresh')
  @Permissions('marketing', 'exec')
  @HttpCode(200)
  refreshAll(@Body(new ZodValidationPipe(RefreshAllBody)) b: any, @CurrentUser() user: JwtUser) {
    return this.crm.refreshAllProfiles(user, { tenantId: b?.tenant_id ?? null });
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
  @RequiresSuite('cdp')
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
  @RequiresSuite('cdp')
  @Permissions('marketing')
  upsertAudienceRule(@Body(new ZodValidationPipe(AudienceRuleBody)) dto: z.infer<typeof AudienceRuleBody>, @CurrentUser() user: JwtUser) {
    return this.crm.upsertAudienceRule(dto, user);
  }
}

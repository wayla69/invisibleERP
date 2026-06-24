import { Controller, Get, Query } from '@nestjs/common';
import { Permissions, CurrentUser, type JwtUser } from '../../common/decorators';
import { LoyaltyAnalyticsService } from './loyalty-analytics.service';

// Loyalty analytics — liability, redemption funnel, breakage, tier mix, churn risk. Read-only; exec/marketing.
// HQ/Admin must pass ?tenant_id= (no cross-tenant aggregate).
@Controller('api/loyalty')
export class LoyaltyAnalyticsController {
  constructor(private readonly svc: LoyaltyAnalyticsService) {}

  @Get('analytics') @Permissions('loyalty', 'marketing', 'exec')
  overview(@Query('tenant_id') tenantId: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.overview(u, tenantId != null ? Number(tenantId) : null);
  }
  @Get('analytics/churn') @Permissions('loyalty', 'marketing', 'exec', 'crm_campaign')
  churn(@Query('tenant_id') tenantId: string | undefined, @Query('limit') limit: string | undefined, @CurrentUser() u: JwtUser) {
    return this.svc.churnList(u, tenantId != null ? Number(tenantId) : null, limit != null ? Number(limit) : 100);
  }
}

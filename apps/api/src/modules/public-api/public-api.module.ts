import { Module } from '@nestjs/common';
import { PublicApiController } from './public-api.controller';
import { PublicApiService } from './public-api.service';
import { PublicApiGuard } from './public-api.guard';
import { PublicLoyaltyService } from './public-loyalty.service';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PlatformModule } from '../platform/platform.module';
import { AutomationModule } from '../automation/automation.module';
import { MarketingIntelModule } from '../marketing-intel/marketing-intel.module';

// Public REST API (v1). Auth is handled by the global JwtAuthGuard (API-key path); this module
// adds the versioned read surface, the scope/rate guard, and the OpenAPI document. LoyaltyModule
// (MemberService) + PlatformModule (WebhookService) + AutomationModule (loyalty automation triggers)
// back the loyalty write API (enrol/earn/redeem).
@Module({
  imports: [LoyaltyModule, PlatformModule, AutomationModule, MarketingIntelModule],
  controllers: [PublicApiController],
  providers: [PublicApiService, PublicApiGuard, PublicLoyaltyService],
})
export class PublicApiModule {}

import { Module } from '@nestjs/common';
import { FactLayerService } from './fact-layer.service';
import { PropensityService } from './propensity.service';
import { MarketingActivationController } from './marketing-activation.controller';
import { MarketingIntelModule } from '../marketing-intel/marketing-intel.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { MenuModule } from '../menu/menu.module';

// Marketing Activation (docs/61) — turns the delivered CRM × Marketing-Intelligence signals into
// sales-driving action. Phase 0 ships the shared read-only Fact Layer; the five tools (①–⑤) layer on top.
// Phase 1 adds ③ Propensity & Cross-Sell (MKT-23), which reuses the owning modules' public reads:
// MarketingIntelModule (pushed MMM/RFM), AnalyticsModule (menu-affinity association rules), MenuModule
// (per-item margin). DRIZZLE is global. A read/scoring model — no GL, no contact, no spend.
@Module({
  imports: [MarketingIntelModule, AnalyticsModule, MenuModule],
  controllers: [MarketingActivationController],
  providers: [FactLayerService, PropensityService],
  exports: [FactLayerService, PropensityService],
})
export class MarketingActivationModule {}

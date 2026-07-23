import { Module } from '@nestjs/common';
import { FactLayerService } from './fact-layer.service';
import { PropensityService } from './propensity.service';
import { SegmentChannelRoiService } from './segment-channel-roi.service';
import { MarketingActivationController } from './marketing-activation.controller';
import { MarketingIntelModule } from '../marketing-intel/marketing-intel.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { MenuModule } from '../menu/menu.module';

// Marketing Activation (docs/61) — turns the delivered CRM × Marketing-Intelligence signals into
// sales-driving action. Phase 0 ships the shared read-only Fact Layer; the five tools (①–⑤) layer on top.
// Phase 1 adds ③ Propensity & Cross-Sell (MKT-23), which reuses the owning modules' public reads:
// MarketingIntelModule (pushed MMM/RFM), AnalyticsModule (menu-affinity association rules), MenuModule
// (per-item margin). Phase 2 adds ⑤ Segment×Channel ROI (MKT-25), which reuses MarketingIntelService's
// MMM channel ROI + the MKT-17 budget-plan maker-checker path. DRIZZLE is global. A read/scoring model —
// no new GL, no new spend path (staging delegates to the existing MKT-17 control).
@Module({
  imports: [MarketingIntelModule, AnalyticsModule, MenuModule],
  controllers: [MarketingActivationController],
  providers: [FactLayerService, PropensityService, SegmentChannelRoiService],
  exports: [FactLayerService, PropensityService, SegmentChannelRoiService],
})
export class MarketingActivationModule {}

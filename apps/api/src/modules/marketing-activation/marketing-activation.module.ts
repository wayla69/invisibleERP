import { Module } from '@nestjs/common';
import { FactLayerService } from './fact-layer.service';
import { PropensityService } from './propensity.service';
import { SegmentChannelRoiService } from './segment-channel-roi.service';
import { NbaOrchestratorService } from './nba-orchestrator.service';
import { CampaignStudioService } from './campaign-studio.service';
import { SaveAutopilotService } from './save-autopilot.service';
import { MarketingActivationController } from './marketing-activation.controller';
import { MarketingIntelModule } from '../marketing-intel/marketing-intel.module';
import { AnalyticsModule } from '../analytics/analytics.module';
import { MenuModule } from '../menu/menu.module';
import { CampaignsModule } from '../campaigns/campaigns.module';

// Marketing Activation (docs/61) — turns the delivered CRM × Marketing-Intelligence signals into
// sales-driving action. Phase 0 ships the shared read-only Fact Layer; the five tools (①–⑤) layer on top.
// Phase 1 adds ③ Propensity & Cross-Sell (MKT-23), which reuses the owning modules' public reads:
// MarketingIntelModule (pushed MMM/RFM), AnalyticsModule (menu-affinity association rules), MenuModule
// (per-item margin). Phase 2 adds ⑤ Segment×Channel ROI (MKT-25), which reuses MarketingIntelService's
// MMM channel ROI + the MKT-17 budget-plan maker-checker path. DRIZZLE is global. A read/scoring model —
// no new GL, no new spend path (staging delegates to the existing MKT-17 control). Phase 3 adds ② NBA
// Orchestrator (MKT-22) — staged per-customer journeys with maker-checker activation; CampaignsModule
// provides the consent-gated draft path (audience:'members'). Phase 4 adds ① AI Campaign Studio (MKT-21) —
// fact-grounded generative campaign drafts with a logged model card; it reuses the Fact Layer + CampaignsModule.
// Phase 5 adds ④ Churn-Save Autopilot (MKT-24) — a maker-checker save-offer policy (capped offer) + a sweep
// that produces a consent-gated draft + a retention P&L.
@Module({
  imports: [MarketingIntelModule, AnalyticsModule, MenuModule, CampaignsModule],
  controllers: [MarketingActivationController],
  providers: [FactLayerService, PropensityService, SegmentChannelRoiService, NbaOrchestratorService, CampaignStudioService, SaveAutopilotService],
  exports: [FactLayerService, PropensityService, SegmentChannelRoiService, NbaOrchestratorService, CampaignStudioService, SaveAutopilotService],
})
export class MarketingActivationModule {}

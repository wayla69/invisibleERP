import { Module } from '@nestjs/common';
import { MarketingIntelService } from './marketing-intel.service';
import { MiExperimentsService } from './mi-experiments.service';
import { MiGovernanceService } from './mi-governance.service';
import { MarketingIntelApprovalQueues } from './marketing-intel-approval-queues';
import { MiBacktestService } from './mi-backtest.service';
import { MarketingIntelBiReports } from './marketing-intel-bi-reports';
import { MarketingIntelController } from './marketing-intel.controller';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { CrmModule } from '../crm/crm.module';
import { BiLiveModule } from '../bi/bi-live.module';
import { MmmModule } from '../mmm/mmm.module';

// docs/48 phase 3 — Marketing Intelligence push-back store + internal read for /marketing-intel + the
// RFM→campaign action loop. Imports CampaignsModule (CampaignsService) so activating a pushed segment
// creates a draft campaign via the existing consent-gated delivery. Exports the service so the public-API
// module can call the analytics:write push into the same bounded context. DRIZZLE is global.
// docs/62 Phase 2: imports MmmModule (exports MmmModelService — the OWNING read for actual per-channel
// spend, mmm_channel_results) so MiBacktestService (MKT-26 plan-vs-actual) reconciles approved budget
// plans against real spend; MarketingIntelBiReports registers the schedulable mkt_plan_backtest sweep.
@Module({
  imports: [CampaignsModule, CrmModule, BiLiveModule, MmmModule],
  controllers: [MarketingIntelController],
  providers: [MarketingIntelService, MiExperimentsService, MiGovernanceService, MarketingIntelApprovalQueues, MiBacktestService, MarketingIntelBiReports],
  exports: [MarketingIntelService, MiExperimentsService, MiGovernanceService],
})
export class MarketingIntelModule {}

import { Module } from '@nestjs/common';
import { MarketingIntelService } from './marketing-intel.service';
import { MiExperimentsService } from './mi-experiments.service';
import { MarketingIntelController } from './marketing-intel.controller';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { CrmModule } from '../crm/crm.module';

// docs/48 phase 3 — Marketing Intelligence push-back store + internal read for /marketing-intel + the
// RFM→campaign action loop. Imports CampaignsModule (CampaignsService) so activating a pushed segment
// creates a draft campaign via the existing consent-gated delivery. Exports the service so the public-API
// module can call the analytics:write push into the same bounded context. DRIZZLE is global.
@Module({
  imports: [CampaignsModule, CrmModule],
  controllers: [MarketingIntelController],
  providers: [MarketingIntelService, MiExperimentsService],
  exports: [MarketingIntelService, MiExperimentsService],
})
export class MarketingIntelModule {}

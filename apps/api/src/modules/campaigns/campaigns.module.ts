import { Module } from '@nestjs/common';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { DocNumberService } from '../../common/doc-number.service';

// Campaign orchestration. Reuses the messaging gateways + message_log; exported so the loyalty maintenance
// sweep can fire due scheduled campaigns.
@Module({
  controllers: [CampaignsController],
  providers: [CampaignsService, DocNumberService],
  exports: [CampaignsService],
})
export class CampaignsModule {}

import { Module } from '@nestjs/common';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { VouchersController } from './vouchers.controller';
import { VouchersService } from './vouchers.service';
import { DocNumberService } from '../../common/doc-number.service';
import { SavedSegmentsService } from '../loyalty/saved-segments.service';
import { MessagingModule } from '../messaging/messaging.module';

// Campaign orchestration. Reuses the messaging gateways + message_log; exported so the loyalty maintenance
// sweep can fire due scheduled campaigns. Also hosts the POS-3 voucher-campaign surface (standalone
// voucher/coupon codes redeemable at checkout) — VouchersService exported so dine-in buildSale can
// validate + atomically redeem a presented code.
@Module({
  // MessagingModule provides TenantMessagingService (W3 governance) so broadcast campaign sends enforce the
  // same global cross-channel marketing cap as journeys/blasts. One-directional (messaging imports no
  // campaigns) → no cycle.
  imports: [MessagingModule],
  controllers: [CampaignsController, VouchersController],
  providers: [CampaignsService, VouchersService, DocNumberService, SavedSegmentsService],
  exports: [CampaignsService, VouchersService],
})
export class CampaignsModule {}

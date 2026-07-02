import { Module } from '@nestjs/common';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';
import { MemberService } from './member.service';
import { ReceiptSubmissionsService } from './receipt-submissions.service';
import { SavedSegmentsController } from './saved-segments.controller';
import { SavedSegmentsService } from './saved-segments.service';
import { LedgerModule } from '../ledger/ledger.module';
import { BiLiveModule } from '../bi/bi-live.module';
import { PlatformModule } from '../platform/platform.module';
import { AutomationModule } from '../automation/automation.module';

// PlatformModule/AutomationModule power the W1 loyalty.points_expiring look-ahead event (webhook fan-out +
// no-code rules). No cycle: platform → automation → messaging/journeys, none of which import LoyaltyModule.
@Module({
  imports: [LedgerModule, BiLiveModule, PlatformModule, AutomationModule],
  controllers: [LoyaltyController, SavedSegmentsController],
  providers: [LoyaltyService, MemberService, ReceiptSubmissionsService, SavedSegmentsService],
  exports: [LoyaltyService, MemberService, ReceiptSubmissionsService],
})
export class LoyaltyModule {}

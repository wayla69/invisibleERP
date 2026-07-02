import { Module } from '@nestjs/common';
import { LoyaltyController } from './loyalty.controller';
import { LoyaltyService } from './loyalty.service';
import { MemberService } from './member.service';
import { ReceiptSubmissionsService } from './receipt-submissions.service';
import { SavedSegmentsController } from './saved-segments.controller';
import { SavedSegmentsService } from './saved-segments.service';
import { LedgerModule } from '../ledger/ledger.module';
import { BiLiveModule } from '../bi/bi-live.module';

@Module({
  imports: [LedgerModule, BiLiveModule],
  controllers: [LoyaltyController, SavedSegmentsController],
  providers: [LoyaltyService, MemberService, ReceiptSubmissionsService, SavedSegmentsService],
  exports: [LoyaltyService, MemberService, ReceiptSubmissionsService],
})
export class LoyaltyModule {}

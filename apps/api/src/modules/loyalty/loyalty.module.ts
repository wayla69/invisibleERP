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
import { LoyaltyAnalyticsModule } from './analytics/loyalty-analytics.module';
import { RewardsModule } from './engagement/rewards.module';
import { ReferralsModule } from './engagement/referrals.module';
import { WheelsModule } from './engagement/wheels.module';
import { GamificationModule } from './engagement/gamification.module';

// PlatformModule/AutomationModule power the W1 loyalty.points_expiring look-ahead event (webhook fan-out +
// no-code rules). No cycle: platform → automation → messaging/journeys, none of which import LoyaltyModule.
// Umbrella (docs/28 consolidation PR #4): analytics/ + engagement/ (rewards, referrals, wheels,
// gamification) live under this module and are re-exported. member/ is co-located here as a folder but
// MemberModule stays OUT of these imports — it depends on LoyaltyModule (+ the engagement modules), so
// importing it back would be a cycle; it remains registered in app.module as a downstream consumer.
// giftcards deliberately stays a separate module (GL 2200 liability + REC-04 — a finance boundary).
@Module({
  imports: [LedgerModule, BiLiveModule, PlatformModule, AutomationModule, LoyaltyAnalyticsModule, RewardsModule, ReferralsModule, WheelsModule, GamificationModule],
  controllers: [LoyaltyController, SavedSegmentsController],
  providers: [LoyaltyService, MemberService, ReceiptSubmissionsService, SavedSegmentsService],
  exports: [LoyaltyService, MemberService, ReceiptSubmissionsService, LoyaltyAnalyticsModule, RewardsModule, ReferralsModule, WheelsModule, GamificationModule],
})
export class LoyaltyModule {}

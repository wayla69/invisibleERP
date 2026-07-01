import { Module } from '@nestjs/common';
import { LoyaltyAnalyticsController } from './loyalty-analytics.controller';
import { LoyaltyAnalyticsService } from './loyalty-analytics.service';
import { BiLiveModule } from '../bi/bi-live.module';

// Loyalty analytics (read-only aggregation over the existing loyalty tables; no new schema).
// BiLiveModule supplies the shared real-time bus so the analytics screen can show a live points feed.
@Module({
  imports: [BiLiveModule],
  controllers: [LoyaltyAnalyticsController],
  providers: [LoyaltyAnalyticsService],
})
export class LoyaltyAnalyticsModule {}

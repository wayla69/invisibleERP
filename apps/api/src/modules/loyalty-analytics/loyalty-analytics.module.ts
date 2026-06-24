import { Module } from '@nestjs/common';
import { LoyaltyAnalyticsController } from './loyalty-analytics.controller';
import { LoyaltyAnalyticsService } from './loyalty-analytics.service';

// Loyalty analytics (read-only aggregation over the existing loyalty tables; no new schema).
@Module({
  controllers: [LoyaltyAnalyticsController],
  providers: [LoyaltyAnalyticsService],
})
export class LoyaltyAnalyticsModule {}

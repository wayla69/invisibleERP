import { Module } from '@nestjs/common';
import { QueryModule } from '../query/query.module';
import { NlAnalyticsService } from './nl-analytics.service';
import { NlAnalyticsController } from './nl-analytics.controller';

// NL analytics (Phase 17 — B3). Reuses the A5 QueryService (governed semantic layer).
@Module({
  imports: [QueryModule],
  controllers: [NlAnalyticsController],
  providers: [NlAnalyticsService],
})
export class NlAnalyticsModule {}

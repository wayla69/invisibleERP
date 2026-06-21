import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { ForecastingService } from './forecasting.service';
import { AnomaliesService } from './anomalies.service';
import { InsightsService } from './insights.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, ForecastingService, AnomaliesService, InsightsService],
  exports: [AnalyticsService, ForecastingService, AnomaliesService, InsightsService],
})
export class AnalyticsModule {}

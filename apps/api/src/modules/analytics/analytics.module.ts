import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { ForecastingService } from './forecasting.service';
import { AnomaliesService } from './anomalies.service';
import { InsightsService } from './insights.service';
import { MenuEngineeringService } from './menu-engineering.service';
import { MenuModule } from '../menu/menu.module';

@Module({
  imports: [MenuModule], // FoodCostService for the menu-engineering margin layer
  controllers: [AnalyticsController],
  providers: [AnalyticsService, ForecastingService, AnomaliesService, InsightsService, MenuEngineeringService],
  exports: [AnalyticsService, ForecastingService, AnomaliesService, InsightsService, MenuEngineeringService],
})
export class AnalyticsModule {}

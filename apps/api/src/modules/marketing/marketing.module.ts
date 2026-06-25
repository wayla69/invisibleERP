import { Module } from '@nestjs/common';
import { MarketingController } from './marketing.controller';
import { MarketingService } from './marketing.service';
import { PromoEngineService } from './promo-engine.service';
import { MarketingAutomationController } from './marketing-automation.controller';
import { MarketingAutomationService } from './marketing-automation.service';

@Module({
  controllers: [MarketingController, MarketingAutomationController],
  providers: [MarketingService, PromoEngineService, MarketingAutomationService],
  exports: [MarketingService, PromoEngineService, MarketingAutomationService],
})
export class MarketingModule {}

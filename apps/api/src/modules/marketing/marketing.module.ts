import { Module } from '@nestjs/common';
import { MarketingController } from './marketing.controller';
import { MarketingService } from './marketing.service';
import { PromoEngineService } from './promo-engine.service';

@Module({
  controllers: [MarketingController],
  providers: [MarketingService, PromoEngineService],
  exports: [MarketingService, PromoEngineService],
})
export class MarketingModule {}

import { Module } from '@nestjs/common';
import { ProfitabilityService } from './profitability.service';
import { ProfitabilityController } from './profitability.controller';

@Module({
  providers: [ProfitabilityService],
  controllers: [ProfitabilityController],
  exports: [ProfitabilityService],
})
export class ProfitabilityModule {}

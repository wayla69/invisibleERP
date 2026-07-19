import { Module } from '@nestjs/common';
import { ConsolidationService } from './consolidation.service';
import { ConsolidationBiReports } from './consolidation-bi-reports';
import { ConsolidationController } from './consolidation.controller';

@Module({
  providers: [ConsolidationService, ConsolidationBiReports],
  controllers: [ConsolidationController],
  exports: [ConsolidationService],
})
export class ConsolidationModule {}

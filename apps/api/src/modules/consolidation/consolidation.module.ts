import { Module } from '@nestjs/common';
import { ConsolidationService } from './consolidation.service';
import { ConsolidationController } from './consolidation.controller';

@Module({
  providers: [ConsolidationService],
  controllers: [ConsolidationController],
  exports: [ConsolidationService],
})
export class ConsolidationModule {}

import { Module } from '@nestjs/common';
import { MatchController } from './match.controller';
import { ThreeWayMatchService } from './three-way-match.service';

// 3-way match (PO↔GR↔Invoice). Exported so FinanceService can gate AP payment. DocNumber/StatusLog are global.
@Module({
  controllers: [MatchController],
  providers: [ThreeWayMatchService],
  exports: [ThreeWayMatchService],
})
export class MatchModule {}

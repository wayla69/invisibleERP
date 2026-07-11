import { Module } from '@nestjs/common';
import { LandedCostController } from './landed-cost.controller';
import { LandedCostService } from './landed-cost.service';
import { LedgerModule } from '../ledger/ledger.module';

// INV-1 — Landed-cost allocation (COST-01). Apportions freight/duty/insurance/broker into inventory unit
// cost over the perpetual sub-ledger and books the capitalisation JE. Reuses LedgerService.
@Module({
  imports: [LedgerModule],
  controllers: [LandedCostController],
  providers: [LandedCostService],
  exports: [LandedCostService],
})
export class LandedCostModule {}

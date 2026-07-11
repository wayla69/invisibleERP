import { Module } from '@nestjs/common';
import { CostingController } from './costing.controller';
import { CostingService } from './costing.service';
import { AtpService } from './atp.service';
import { StdCostService } from './std-cost.service';
import { LedgerModule } from '../ledger/ledger.module';

// Inventory costing (FIFO/AVG/STD) + valuation + ATP + standard-cost roll (COST-02). Exported so GR/sale/
// return paths can opt in. DocNumberService is provided globally (CommonModule).
@Module({
  imports: [LedgerModule],
  controllers: [CostingController],
  providers: [CostingService, AtpService, StdCostService],
  exports: [CostingService, AtpService, StdCostService],
})
export class CostingModule {}
